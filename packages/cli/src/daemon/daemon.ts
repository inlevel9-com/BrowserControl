// Daemon: JSON-lines IPC for the CLI, session routing to extensions, per-session queues, lifecycle files.
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  type ArtifactReadParams,
  type BrowserListResult,
  type DownloadFetchParams,
  type DownloadsResult,
  DEFAULT_WS_PORT,
  isRequestFrame,
  isToolMethod,
  methodEffect,
  PROTOCOL_VERSION,
  type RecordFrameEvent,
  type RecordStartParams,
  type RecordStartResult,
  type RecordStopParams,
  type RecordStopResult,
  type RemoteStatusResult,
  type RequestFrame,
  type ResponseFrame,
  RpcFailure,
  rpcError,
  type SessionListResult,
  type SessionStartParams,
  type SessionStartResult,
  type SessionStopResult,
  type StatusResult,
  type ToolSessionStartResult,
  type ToolSessionStopResult,
  type WaitMsParams,
} from "@browser-control/protocol";
import { bctlHome, daemonJsonPath, lockPath, logPath, runDir, sockPath } from "../paths";
import { readServerConfig, type RemoteContext, RemoteServer } from "../remote";
import { VERSION } from "../version";
import { ArtifactStore } from "./artifacts";
import { type Recording, RecordingManager } from "./recording";
import { type BrowserClient, DaemonState, type DaemonSession } from "./state";
import { asRpcError, ExtensionServer } from "./ws-server";

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const SESSION_IDLE_MS = Number(process.env.BCTL_SESSION_IDLE_SECS ?? 1800) * 1000;

export interface DaemonInfo {
  pid: number;
  sock_path: string;
  ws_port: number;
  version: string;
  protocol_version: string;
  started_at: string;
}

export function readDaemonInfo(): DaemonInfo | null {
  try {
    return JSON.parse(readFileSync(daemonJsonPath(), "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class Daemon {
  readonly state = new DaemonState();
  private ext: ExtensionServer;
  private ipc: Server | null = null;
  private startedAt = Date.now();
  private wsPort = DEFAULT_WS_PORT;
  private logFd: number | null = null;
  private shuttingDown = false;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  readonly artifacts = new ArtifactStore();
  readonly recordings: RecordingManager;
  private remote: RemoteServer;
  private remoteError = "";

  constructor(private readonly opts: { port: number; foreground: boolean }) {
    this.ext = new ExtensionServer(this.state, (m) => this.log(m));
    this.recordings = new RecordingManager(this.artifacts, (m) => this.log(m));
    this.remote = new RemoteServer((req, ctx) => this.handle(req, ctx), (m) => this.log(m));
    this.ext.on("browser.disconnected", (b: BrowserClient, reason: string) => {
      this.log(`browser disconnected: ${b.instanceId} (${reason})`);
      for (const s of Array.from(this.state.sessions.values())) {
        if (s.browserInstanceId === b.instanceId) this.endSession(s.id, "browser_disconnected");
      }
    });
    this.ext.on("event", (b: BrowserClient, event: string, payload: unknown) => this.onExtensionEvent(b, event, payload as Record<string, unknown>));
  }

  log(msg: string): void {
    const line = `${new Date().toISOString()} ${msg}\n`;
    if (this.logFd !== null) {
      try {
        writeSync(this.logFd, line);
      } catch {
        /* ignore */
      }
    }
    if (this.opts.foreground && process.stderr.isTTY) process.stderr.write(line);
  }

  async start(): Promise<void> {
    mkdirSync(runDir(), { recursive: true });
    this.acquireLock();
    this.logFd = openSync(logPath(), "a");
    this.wsPort = await this.ext.listen(this.opts.port);
    await this.listenIpc();
    const info: DaemonInfo = { pid: process.pid, sock_path: sockPath(), ws_port: this.wsPort, version: VERSION, protocol_version: PROTOCOL_VERSION, started_at: new Date(this.startedAt).toISOString() };
    writeFileSync(daemonJsonPath(), JSON.stringify(info, null, 2));
    this.idleTimer = setInterval(() => this.reapIdleSessions(), 60_000);
    this.recordings.cleanup();
    await this.applyRemoteConfig();
    this.log(`daemon ${VERSION} started pid=${process.pid} ws=127.0.0.1:${this.wsPort} ipc=${sockPath()} home=${bctlHome()}`);
    const stop = () => void this.shutdown("signal");
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.on("SIGHUP", stop);
  }

  private acquireLock(): void {
    const lp = lockPath();
    if (existsSync(lp)) {
      const old = Number(readFileSync(lp, "utf8").trim());
      if (old && old !== process.pid && pidAlive(old)) throw new Error(`another bctl daemon is running (pid ${old}); use \`bctl daemon stop\` first`);
      rmSync(lp, { force: true });
    }
    writeFileSync(lp, String(process.pid), { flag: "wx" });
  }

  private async listenIpc(): Promise<void> {
    const path = sockPath();
    if (process.platform !== "win32") {
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path)) unlinkSync(path);
    }
    this.ipc = createServer((sock) => this.onIpcConnection(sock));
    await new Promise<void>((resolve, reject) => {
      this.ipc!.once("error", reject);
      this.ipc!.listen(path, () => resolve());
    });
  }

  private onIpcConnection(sock: Socket): void {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let frame: unknown;
        try {
          frame = JSON.parse(line);
        } catch {
          sock.write(`${JSON.stringify({ id: "?", error: rpcError("protocol_error", "malformed JSON line") })}\n`);
          continue;
        }
        if (!isRequestFrame(frame)) continue;
        void this.handle(frame).then((resp) => {
          if (!sock.destroyed) sock.write(`${JSON.stringify(resp)}\n`);
        });
      }
    });
    sock.on("error", () => {});
  }

  /** Start, move, or stop the remote listener to match ~/.bctl/remote.json. */
  private async applyRemoteConfig(): Promise<void> {
    const cfg = readServerConfig();
    this.remoteError = "";
    try {
      if (!cfg.enabled) {
        if (this.remote.listening) this.log("remote access disabled");
        await this.remote.close();
        return;
      }
      const want = `${cfg.host}:${cfg.port}`;
      if (this.remote.listening && (this.remote.listening === want || this.remote.listening === `[${cfg.host}]:${cfg.port}`)) return;
      const at = await this.remote.listen(cfg.host, cfg.port);
      this.log(`remote access listening on ${at} (${cfg.clients.length} paired client(s))`);
    } catch (e) {
      this.remoteError = (e as Error).message;
      this.log(`remote access failed: ${this.remoteError}`);
    }
  }

  private remoteStatus(): RemoteStatusResult & { error?: string } {
    const cfg = readServerConfig();
    return {
      enabled: cfg.enabled,
      ...(this.remote.listening ? { listening: this.remote.listening } : {}),
      ...(this.remoteError ? { error: this.remoteError } : {}),
      clients: cfg.clients.map((c) => ({ client_id: c.client_id, name: c.name, created_at: c.created_at, ...(c.last_used_at ? { last_used_at: c.last_used_at } : {}) })),
    };
  }

  private async handle(req: RequestFrame, ctx?: RemoteContext): Promise<ResponseFrame> {
    const { id, method } = req;
    const params = (req.params ?? {}) as Record<string, unknown>;
    try {
      if (ctx && (method === "system.shutdown" || method.startsWith("remote."))) {
        throw new RpcFailure(rpcError("permission_denied", `${method} is only available on the browser's machine`, { reason: "remote_forbidden" }));
      }
      if (ctx && method === "session.start") {
        const c = (params.controller ?? {}) as { name?: string; project?: string };
        params.controller = { name: c.name || "agent", project: [c.project, `remote: ${ctx.name}`].filter(Boolean).join(" · ") };
      }
      const result = await this.dispatch(method, params);
      return { id, result };
    } catch (e) {
      return { id, error: asRpcError(e) };
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "system.ping":
        return { pong: true, version: VERSION, protocol_version: PROTOCOL_VERSION, pid: process.pid };
      case "system.status":
        return this.status();
      case "system.shutdown":
        setTimeout(() => void this.shutdown("ipc"), 50);
        return { ok: true };
      case "browser.list":
        return { browsers: Array.from(this.state.browsers.values()).map((b) => this.state.browserEntry(b)) } satisfies BrowserListResult;
      case "session.start":
        return this.sessionStart(params as SessionStartParams);
      case "session.stop":
        return this.sessionStop(String(params.session_id ?? ""));
      case "session.stop_all": {
        const out = [];
        for (const id of Array.from(this.state.sessions.keys())) out.push(await this.sessionStop(id).catch((e) => ({ session_id: id, error: asRpcError(e) })));
        return { stopped: out };
      }
      case "session.resume": {
        const s = this.requireSession(String(params.session_id ?? ""));
        s.interrupted = false;
        return { session_id: s.id, interrupted: false };
      }
      case "session.list":
        return { sessions: Array.from(this.state.sessions.values()).map((s) => this.state.sessionEntry(s)) } satisfies SessionListResult;
      case "record.start":
        return this.recordStart(params as unknown as RecordStartParams);
      case "record.stop":
        return this.recordStop(params as unknown as RecordStopParams);
      case "download.fetch":
        return this.downloadFetch(params as unknown as DownloadFetchParams);
      case "artifact.read": {
        const p = params as unknown as ArtifactReadParams;
        return this.artifacts.read(String(p.artifact_id ?? ""), Number(p.offset ?? 0), Number(p.length ?? 0));
      }
      case "artifact.list":
        return { artifacts: this.artifacts.list(params.session_id ? String(params.session_id) : undefined) };
      case "remote.status":
        return this.remoteStatus();
      case "remote.reload":
        await this.applyRemoteConfig();
        return this.remoteStatus();
      case "tool.record_start":
      case "tool.record_stop":
        throw new RpcFailure(rpcError("invalid_params", `${method} is internal; use record.start / record.stop`, { reason: "internal_method" }));
      case "tool.wait_ms": {
        const ms = Math.max(0, Math.min(Number((params as unknown as WaitMsParams).ms ?? 0), 600_000));
        await new Promise((r) => setTimeout(r, ms));
        return { waited_ms: ms };
      }
      default:
        if (isToolMethod(method)) return this.forwardTool(method, params);
        throw new RpcFailure(rpcError("unknown_method", `unknown method ${method}`));
    }
  }

  private status(): StatusResult {
    return {
      daemon_version: VERSION,
      protocol_version: PROTOCOL_VERSION,
      pid: process.pid,
      uptime_secs: Math.round((Date.now() - this.startedAt) / 1000),
      ws_port: this.wsPort,
      sock_path: sockPath(),
      home: bctlHome(),
      browsers: Array.from(this.state.browsers.values()).map((b) => this.state.browserEntry(b)),
      sessions: Array.from(this.state.sessions.values()).map((s) => this.state.sessionEntry(s)),
    };
  }

  private requireSession(id: string): DaemonSession {
    const s = this.state.sessions.get(id);
    if (s) return s;
    const tomb = this.state.tombstones.get(id);
    if (tomb) {
      const hints: Record<string, string> = {
        user_closed_window: "the user closed the Agent Window; start a new session if the task should continue",
        browser_disconnected: "the browser extension disconnected; check the popup, then start a new session",
        idle_timeout: "the session was idle too long; start a new session",
        stopped: "the session was stopped; start a new session",
      };
      throw new RpcFailure(rpcError("not_found", `session ${id} ended (${tomb.reason})`, { reason: `session_${tomb.reason}`, hint: hints[tomb.reason] ?? "start a new session" }));
    }
    throw new RpcFailure(rpcError("not_found", `session ${id} not found`, { reason: "session_not_found", hint: "run `bctl session list` or start one with `bctl session start --json`" }));
  }

  private browserFor(s: DaemonSession): BrowserClient {
    const b = this.state.browsers.get(s.browserInstanceId);
    if (!b) throw new RpcFailure(rpcError("browser_disconnected", `browser ${s.browserInstanceId} for session ${s.id} is disconnected`));
    return b;
  }

  private async sessionStart(p: SessionStartParams): Promise<SessionStartResult> {
    const sel = this.state.selectBrowser(p.browser);
    if ("error" in sel) throw new RpcFailure(rpcError(sel.code === "not_found" ? "not_found" : sel.code, sel.error, { reason: sel.code }));
    const client = sel.client;
    const id = this.state.newSessionId();
    const r = (await this.ext.call(client, "tool.session_start", { session_id: id, focused: p.focused, width: p.width, height: p.height, incognito: p.incognito, controller: p.controller }, 20_000)) as ToolSessionStartResult;
    const s: DaemonSession = {
      id,
      browserInstanceId: client.instanceId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      agentWindowId: r.agent_window_id,
      activeTabId: r.active_tab_id,
      interrupted: false,
      controller: p.controller,
      queue: Promise.resolve(),
    };
    this.state.sessions.set(id, s);
    this.log(`session ${id} started on ${client.instanceId} window=${r.agent_window_id}`);
    return { session_id: id, browser_instance_id: client.instanceId, browser: client.browser, agent_window_id: r.agent_window_id, active_tab_id: r.active_tab_id };
  }

  private async sessionStop(id: string): Promise<SessionStopResult> {
    const s = this.requireSession(id);
    this.state.sessions.delete(id);
    this.state.tombstones.set(id, { reason: "stopped", at: Date.now() });
    let result: ToolSessionStopResult = { returned_tabs: [], closed_tabs: [] };
    const b = this.state.browsers.get(s.browserInstanceId);
    if (b) {
      try {
        result = (await this.ext.call(b, "tool.session_stop", { session_id: id }, 20_000)) as ToolSessionStopResult;
      } catch (e) {
        this.log(`session ${id} stop: extension error ${asRpcError(e).message}`);
      }
    }
    this.log(`session ${id} stopped (returned ${result.returned_tabs.length}, closed ${result.closed_tabs.length})`);
    const rec = this.finishRecording(id, "session_ended");
    if (rec) await Promise.race([rec.catch(() => undefined), new Promise((r) => setTimeout(r, 15_000))]);
    return { session_id: id, ...result };
  }

  private endSession(id: string, reason: string): void {
    if (!this.state.sessions.delete(id)) return;
    this.state.tombstones.set(id, { reason, at: Date.now() });
    this.log(`session ${id} ended: ${reason}`);
    this.finishRecording(id, "session_ended");
  }

  // ------------------------------------------------------------------------- recording

  private finishRecording(sessionId: string, reason: string): Promise<RecordStopResult> | undefined {
    const rec = this.recordings.activeFor(sessionId);
    if (!rec) return undefined;
    const p = this.recordings.finish(rec, reason);
    p.catch(() => undefined);
    return p;
  }

  private async recordStart(p: RecordStartParams): Promise<RecordStartResult> {
    const s = this.requireSession(String(p.session_id ?? ""));
    const format = p.format ?? "mp4";
    if (!["mp4", "webm", "avi"].includes(format)) throw new RpcFailure(rpcError("invalid_params", `unknown format ${format}; use mp4, webm or avi`));
    const maxSecs = Math.max(1, Math.min(Number(p.max_secs ?? 300), 3600));
    const rec: Recording = this.recordings.start(s.id, format);
    let r: { tab_id: number };
    try {
      r = (await this.forwardTool("tool.record_start", {
        session_id: s.id,
        ...(p.tab_id !== undefined ? { tab_id: p.tab_id } : {}),
        recording_id: rec.id,
        quality: p.quality,
        max_width: p.max_width,
        max_height: p.max_height,
      })) as { tab_id: number };
    } catch (e) {
      this.recordings.discard(rec);
      throw e;
    }
    rec.maxTimer = setTimeout(() => {
      this.log(`recording ${rec.id} reached ${maxSecs}s; stopping`);
      const b = this.state.browsers.get(s.browserInstanceId);
      if (b) void this.ext.call(b, "tool.record_stop", { session_id: s.id }, 10_000).catch(() => undefined);
      void this.recordings.finish(rec, "max_duration").catch(() => undefined);
    }, maxSecs * 1000);
    this.log(`recording ${rec.id} started for session ${s.id} tab ${r.tab_id} (${format}, max ${maxSecs}s)`);
    return { recording_id: rec.id, session_id: s.id, tab_id: r.tab_id, max_secs: maxSecs };
  }

  private async recordStop(p: RecordStopParams): Promise<RecordStopResult> {
    const sid = String(p.session_id ?? "");
    const rec = this.recordings.lastFor(sid);
    if (!rec) {
      this.requireSession(sid);
      throw new RpcFailure(rpcError("not_found", `session ${sid} is not recording`, { reason: "not_recording", hint: "start one with `bctl record start`" }));
    }
    if (!rec.finishing && this.state.sessions.has(sid)) {
      const s = this.state.sessions.get(sid)!;
      const b = this.state.browsers.get(s.browserInstanceId);
      if (b) await this.ext.call(b, "tool.record_stop", { session_id: sid }, 10_000).catch((e) => this.log(`record stop: ${asRpcError(e).message}`));
    }
    return this.recordings.finish(rec, "stopped", p.format);
  }

  // ------------------------------------------------------------------------- downloads

  private async downloadFetch(p: DownloadFetchParams) {
    const s = this.requireSession(String(p.session_id ?? ""));
    const id = Number(p.download_id);
    const r = (await this.forwardTool("tool.downloads", { session_id: s.id, download_id: id })) as DownloadsResult;
    const d = r.waited;
    if (!d) throw new RpcFailure(rpcError("not_found", `download ${id} not found`, { reason: "download_not_found" }));
    if (d.state !== "complete") throw new RpcFailure(rpcError("unsupported", `download ${id} is ${d.state}${d.error ? ` (${d.error})` : ""}`, { reason: `download_${d.state}`, hint: d.state === "in_progress" ? "wait with `bctl downloads wait`" : "start the download again" }));
    let size: number;
    try {
      size = statSync(d.filename).size;
    } catch {
      throw new RpcFailure(rpcError("not_found", `downloaded file ${d.filename} is gone`, { reason: "download_file_missing" }));
    }
    return this.artifacts.add({ kind: "download", name: d.basename, mime: d.mime ?? "application/octet-stream", path: d.filename, size, session_id: s.id });
  }

  forwardTool(method: string, params: Record<string, unknown>): Promise<unknown> {
    const s = this.requireSession(String(params.session_id ?? ""));
    if (s.interrupted && methodEffect(method) === "mutate") {
      throw new RpcFailure(rpcError("user_aborted", `the user pressed Stop on session ${s.id}; browser actions are blocked`, { reason: "user_interrupt", hint: "ask the user how to proceed; `bctl session resume <id>` re-enables actions, `bctl session stop <id>` ends it" }));
    }
    const client = this.browserFor(s);
    const timeout = toolTimeout(method, params);
    const run = async () => {
      s.lastActivityAt = Date.now();
      const r = await this.ext.call(client, method, params, timeout);
      s.lastActivityAt = Date.now();
      if (method === "tool.tab_select" || method === "tool.tab_borrow") s.activeTabId = Number(params.tab_id);
      if (method === "tool.tab_create" && (params.active ?? true)) s.activeTabId = (r as { tab_id: number }).tab_id;
      return r;
    };
    // Per-session serialisation: one browser action at a time per session; sessions run in parallel.
    const next = s.queue.then(run, run);
    s.queue = next.catch(() => undefined);
    return next;
  }

  private onExtensionEvent(b: BrowserClient, event: string, payload: Record<string, unknown>): void {
    const sid = String(payload?.session_id ?? "");
    switch (event) {
      case "session.window_closed":
        this.endSession(sid, "user_closed_window");
        break;
      case "session.user_interrupt": {
        const s = this.state.sessions.get(sid);
        if (s) {
          s.interrupted = true;
          this.log(`session ${sid}: user interrupt`);
        }
        break;
      }
      case "record.frame":
        this.recordings.addFrame(payload as unknown as RecordFrameEvent);
        break;
      case "record.ended": {
        const rec = this.recordings.activeFor(sid);
        if (rec && rec.id === payload.recording_id) {
          this.log(`recording ${rec.id} ended: ${payload.reason}`);
          void this.recordings.finish(rec, String(payload.reason ?? "ended")).catch(() => undefined);
        }
        break;
      }
      case "dialog.changed":
        this.log(`session ${sid}: dialog ${payload.dialog ? "opened" : "closed"} on tab ${payload.tab_id}`);
        break;
      default:
        this.log(`event ${event} from ${b.instanceId}: ${JSON.stringify(payload).slice(0, 200)}`);
    }
  }

  private reapIdleSessions(): void {
    if (SESSION_IDLE_MS <= 0) return;
    const now = Date.now();
    for (const s of Array.from(this.state.sessions.values())) {
      if (now - s.lastActivityAt > SESSION_IDLE_MS) {
        this.log(`session ${s.id} idle for ${Math.round((now - s.lastActivityAt) / 1000)}s; stopping`);
        void this.sessionStop(s.id).catch(() => this.endSession(s.id, "idle_timeout"));
      }
    }
    for (const [id, t] of this.state.tombstones) if (now - t.at > 6 * 3600_000) this.state.tombstones.delete(id);
  }

  async shutdown(why: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log(`shutting down (${why})`);
    if (this.idleTimer) clearInterval(this.idleTimer);
    for (const id of Array.from(this.state.sessions.keys())) await this.sessionStop(id).catch(() => {});
    await this.ext.close().catch(() => {});
    await this.remote.close().catch(() => {});
    await new Promise<void>((r) => (this.ipc ? this.ipc.close(() => r()) : r()));
    for (const f of [daemonJsonPath(), lockPath()]) rmSync(f, { force: true });
    if (process.platform !== "win32") rmSync(sockPath(), { force: true });
    process.exit(0);
  }
}

function toolTimeout(method: string, params: Record<string, unknown>): number {
  const t = Number(params.timeout_ms);
  const base = Number.isFinite(t) && t > 0 ? t : 0;
  switch (method) {
    case "tool.navigate":
    case "tool.reload":
    case "tool.navigate_back":
    case "tool.navigate_forward":
    case "tool.wait_for_element":
    case "tool.wait_for_navigation":
      return (base || 30_000) + 5_000;
    case "tool.screenshot":
    case "tool.pdf":
      return 60_000;
    case "tool.evaluate":
      return (base || 15_000) + 5_000;
    default:
      return DEFAULT_TOOL_TIMEOUT_MS;
  }
}
