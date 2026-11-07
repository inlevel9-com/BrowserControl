// Recording sink: stores screencast frames pushed by the extension and encodes them on stop.
// mp4/webm need ffmpeg (on PATH or BCTL_FFMPEG); without it the recording falls back to a
// built-in Motion-JPEG AVI.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type RecordFrameEvent, type RecordingFormat, type RecordStopResult, RpcFailure, rpcError } from "@browser-control/protocol";
import { recordingsDir } from "../paths";
import type { ArtifactStore } from "./artifacts";
import { jpegSize, type TimedFrame, writeMjpegAvi } from "./avi";

const MAX_FRAMES = 20_000;
const MAX_BYTES = 1_500 * 1024 * 1024;
const KEEP_DAYS = 7;

export interface Recording {
  id: string;
  sessionId: string;
  dir: string;
  frames: TimedFrame[];
  bytes: number;
  startedAt: number;
  format: RecordingFormat;
  maxTimer?: ReturnType<typeof setTimeout>;
  /** Set once stopping began; resolves to the finished result. */
  finishing?: Promise<RecordStopResult>;
  result?: RecordStopResult;
  dropped: number;
}

export function findFfmpeg(): string | null {
  const candidates = [process.env.BCTL_FFMPEG, "ffmpeg"].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["-hide_banner", "-version"], { timeout: 5000, windowsHide: true });
      if (r.status === 0) return c;
    } catch {
      /* not found */
    }
  }
  return null;
}

export class RecordingManager {
  private active = new Map<string, Recording>();
  private finished = new Map<string, Recording>();

  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly log: (m: string) => void,
  ) {}

  /** Delete encoded recordings older than a week and stray frame folders. */
  cleanup(): void {
    const dir = recordingsDir();
    if (!existsSync(dir)) return;
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs < cutoff || name.endsWith(".frames")) rmSync(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  activeFor(sessionId: string): Recording | undefined {
    return this.active.get(sessionId);
  }

  lastFor(sessionId: string): Recording | undefined {
    return this.active.get(sessionId) ?? this.finished.get(sessionId);
  }

  start(sessionId: string, format: RecordingFormat): Recording {
    if (this.active.has(sessionId)) throw new RpcFailure(rpcError("invalid_params", `session ${sessionId} is already recording`, { reason: "already_recording", hint: "run `bctl record stop` first" }));
    const id = `r${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    const dir = join(recordingsDir(), `${id}.frames`);
    mkdirSync(dir, { recursive: true });
    const rec: Recording = { id, sessionId, dir, frames: [], bytes: 0, startedAt: Date.now(), format, dropped: 0 };
    this.active.set(sessionId, rec);
    return rec;
  }

  discard(rec: Recording): void {
    if (rec.maxTimer) clearTimeout(rec.maxTimer);
    this.active.delete(rec.sessionId);
    rmSync(rec.dir, { recursive: true, force: true });
  }

  addFrame(ev: RecordFrameEvent): void {
    const rec = this.active.get(ev.session_id);
    if (!rec || rec.id !== ev.recording_id || rec.finishing) return;
    if (rec.frames.length >= MAX_FRAMES || rec.bytes >= MAX_BYTES) {
      rec.dropped++;
      return;
    }
    const buf = Buffer.from(ev.data, "base64");
    const file = join(rec.dir, `f${String(rec.frames.length).padStart(6, "0")}.jpg`);
    writeFileSync(file, buf);
    rec.bytes += buf.length;
    const ts = Number.isFinite(ev.ts) ? ev.ts : Date.now();
    // Keep timestamps monotonic even if the browser clock jumps.
    const prev = rec.frames[rec.frames.length - 1]?.ts ?? 0;
    rec.frames.push({ file, ts: Math.max(ts, prev) });
  }

  /** Stop accepting frames and encode. Idempotent: later calls get the same result. */
  finish(rec: Recording, reason: string, format?: RecordingFormat): Promise<RecordStopResult> {
    if (rec.finishing) return rec.finishing;
    if (rec.maxTimer) clearTimeout(rec.maxTimer);
    const endTs = Date.now();
    rec.finishing = this.encode(rec, endTs, reason, format ?? rec.format).then(
      (r) => {
        rec.result = r;
        this.active.delete(rec.sessionId);
        this.finished.set(rec.sessionId, rec);
        this.log(`recording ${rec.id} saved ${r.artifact.path} (${r.frames} frames, ${r.duration_ms}ms, ${r.encoder}, ${reason})`);
        return r;
      },
      (e) => {
        this.active.delete(rec.sessionId);
        this.log(`recording ${rec.id} failed: ${(e as Error).message}`);
        throw e;
      },
    );
    return rec.finishing;
  }

  private async encode(rec: Recording, endTs: number, reason: string, format: RecordingFormat): Promise<RecordStopResult> {
    // A late frame may still be in flight; give it a moment.
    await new Promise((r) => setTimeout(r, 150));
    if (rec.frames.length === 0) {
      rmSync(rec.dir, { recursive: true, force: true });
      throw new RpcFailure(rpcError("not_found", "no frames were captured", { reason: "no_frames", hint: "the tab never painted while recording; keep the Agent Window visible (session start --focus) and interact with the page before stopping" }));
    }
    const t0 = rec.frames[0]!.ts;
    const last = rec.frames[rec.frames.length - 1]!.ts;
    // Browser and daemon share a clock, but guard against skew: show the last frame ≥ 0.5 s.
    const end = Math.max(endTs, last + 500);
    const durationMs = end - t0;
    let used: RecordingFormat = format;
    let encoder = "builtin-mjpeg";
    const base = join(recordingsDir(), rec.id);
    let out = `${base}.${format}`;
    const ffmpeg = format === "avi" ? null : findFfmpeg();
    if (format !== "avi" && ffmpeg) {
      try {
        encoder = await encodeWithFfmpeg(ffmpeg, rec.frames, end, out, format);
      } catch (e) {
        this.log(`ffmpeg failed (${(e as Error).message}); falling back to AVI`);
        used = "avi";
      }
    } else if (format !== "avi") {
      used = "avi";
      encoder = "builtin-mjpeg (ffmpeg not found)";
    }
    if (used === "avi") {
      out = `${base}.avi`;
      writeMjpegAvi(rec.frames, end, out, 10);
    }
    const frames = rec.frames.length;
    rmSync(rec.dir, { recursive: true, force: true });
    const artifact = this.artifacts.add({
      kind: "recording",
      name: `${rec.id}.${used}`,
      mime: used === "mp4" ? "video/mp4" : used === "webm" ? "video/webm" : "video/x-msvideo",
      path: out,
      session_id: rec.sessionId,
    });
    return { recording_id: rec.id, artifact, frames, duration_ms: durationMs, format: used, encoder, reason };
  }
}

async function encodeWithFfmpeg(ffmpeg: string, frames: TimedFrame[], endTs: number, out: string, format: RecordingFormat): Promise<string> {
  const first = jpegSize(readFileSync(frames[0]!.file)) ?? { width: 1280, height: 800 };
  const w = first.width + (first.width % 2);
  const h = first.height + (first.height % 2);
  const lines = ["ffconcat version 1.0"];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1]!.ts : endTs;
    lines.push(`file '${f.file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`, `duration ${Math.max(0.001, (next - f.ts) / 1000).toFixed(3)}`);
  });
  // The concat demuxer ignores the last entry's duration unless the file is repeated.
  lines.push(`file '${frames[frames.length - 1]!.file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
  const list = `${out}.txt`;
  writeFileSync(list, `${lines.join("\n")}\n`);
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=25,format=yuv420p`;
  const attempts: Array<{ name: string; args: string[] }> =
    format === "webm"
      ? [{ name: "ffmpeg/libvpx-vp9", args: ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "36", "-row-mt", "1", "-deadline", "realtime"] }]
      : [
          { name: "ffmpeg/libx264", args: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-movflags", "+faststart"] },
          { name: "ffmpeg/mpeg4", args: ["-c:v", "mpeg4", "-q:v", "4", "-movflags", "+faststart"] },
        ];
  try {
    let lastErr = "";
    for (const a of attempts) {
      const r = await runFfmpeg(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-vf", vf, ...a.args, "-an", out]);
      if (r.code === 0 && existsSync(out) && statSync(out).size > 0) return a.name;
      lastErr = r.stderr.trim().split("\n").slice(-2).join(" ");
    }
    throw new Error(lastErr || "ffmpeg exited with an error");
  } finally {
    rmSync(list, { force: true });
  }
}

function runFfmpeg(bin: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => resolve({ code: -1, stderr: String(e) }));
    p.on("close", (code) => resolve({ code, stderr }));
  });
}
