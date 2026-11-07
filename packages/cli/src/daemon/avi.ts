// Dependency-free Motion-JPEG AVI writer, used when ffmpeg is not installed. The screencast already
// delivers JPEG frames, so the "encoding" is just a RIFF container. Plays in VLC, mpv, Windows
// Media Player, and browsers via ffmpeg-based tools.
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";

export interface TimedFrame {
  file: string;
  /** Capture time, epoch ms. */
  ts: number;
}

/** Width/height from a JPEG's SOF marker, or null when not a JPEG. */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * Pick which captured frame is shown at each tick of a constant-rate timeline. Screencast frames
 * only arrive when the page repaints, so a frame is repeated until the next one.
 */
export function sampleTimeline(frames: TimedFrame[], endTs: number, fps: number): number[] {
  if (frames.length === 0) return [];
  const t0 = frames[0]!.ts;
  const total = Math.max(endTs - t0, frames[frames.length - 1]!.ts - t0 + 1000 / fps);
  const ticks = Math.max(1, Math.ceil((total / 1000) * fps));
  const out: number[] = [];
  let i = 0;
  for (let k = 0; k < ticks; k++) {
    const t = t0 + (k * 1000) / fps;
    while (i + 1 < frames.length && frames[i + 1]!.ts <= t) i++;
    out.push(i);
  }
  return out;
}

function fourcc(s: string): Buffer {
  return Buffer.from(s, "ascii");
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}
function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff);
  return b;
}

/** Write an MJPEG AVI. Returns the number of video frames written. */
export function writeMjpegAvi(frames: TimedFrame[], endTs: number, outPath: string, fps = 10): { frames: number; width: number; height: number; durationMs: number } {
  const seq = sampleTimeline(frames, endTs, fps);
  if (seq.length === 0) throw new Error("no frames to write");
  const first = readFileSync(frames[0]!.file);
  const dims = jpegSize(first) ?? { width: 1280, height: 800 };
  const { width, height } = dims;

  const fd = openSync(outPath, "w");
  let pos = 0;
  const write = (b: Buffer, at?: number) => {
    writeSync(fd, b, 0, b.length, at ?? pos);
    if (at === undefined) pos += b.length;
  };
  try {
    const usPerFrame = Math.round(1_000_000 / fps);
    const avih = Buffer.concat([
      u32(usPerFrame), u32(0), u32(0), u32(0x10), u32(seq.length), u32(0), u32(1), u32(0), u32(width), u32(height), u32(0), u32(0), u32(0), u32(0),
    ]);
    const strh = Buffer.concat([
      fourcc("vids"), fourcc("MJPG"), u32(0), u16(0), u16(0), u32(0), u32(1), u32(fps), u32(0), u32(seq.length), u32(0), u32(0xffffffff), u32(0),
      u16(0), u16(0), u16(width), u16(height),
    ]);
    const strf = Buffer.concat([u32(40), u32(width), u32(height), u16(1), u16(24), fourcc("MJPG"), u32(width * height * 3), u32(0), u32(0), u32(0), u32(0)]);
    const strl = Buffer.concat([fourcc("strl"), fourcc("strh"), u32(strh.length), strh, fourcc("strf"), u32(strf.length), strf]);
    const hdrl = Buffer.concat([fourcc("hdrl"), fourcc("avih"), u32(avih.length), avih, fourcc("LIST"), u32(strl.length), strl]);

    write(fourcc("RIFF"));
    const riffSizeAt = pos;
    write(u32(0));
    write(fourcc("AVI "));
    write(fourcc("LIST"));
    write(u32(hdrl.length));
    write(hdrl);
    write(fourcc("LIST"));
    const moviSizeAt = pos;
    write(u32(0));
    const moviFourccAt = pos;
    write(fourcc("movi"));

    const index: Array<{ offset: number; size: number }> = [];
    let cachedIdx = -1;
    let cached: Buffer = first;
    for (const fi of seq) {
      if (fi !== cachedIdx) {
        cached = fi === 0 ? first : readFileSync(frames[fi]!.file);
        cachedIdx = fi;
      }
      index.push({ offset: pos - moviFourccAt, size: cached.length });
      write(fourcc("00dc"));
      write(u32(cached.length));
      write(cached);
      if (cached.length % 2) write(Buffer.alloc(1));
      if (pos > 0x3f000000) throw new Error("recording too large for AVI; install ffmpeg for mp4 output");
    }
    write(u32(pos - moviFourccAt), moviSizeAt);
    const idx = Buffer.alloc(16 * index.length);
    index.forEach((e, k) => {
      idx.write("00dc", k * 16, "ascii");
      idx.writeUInt32LE(0x10, k * 16 + 4);
      idx.writeUInt32LE(e.offset, k * 16 + 8);
      idx.writeUInt32LE(e.size, k * 16 + 12);
    });
    write(fourcc("idx1"));
    write(u32(idx.length));
    write(idx);
    write(u32(pos - 8), riffSizeAt);
  } finally {
    closeSync(fd);
  }
  return { frames: seq.length, width, height, durationMs: Math.round((seq.length * 1000) / fps) };
}
