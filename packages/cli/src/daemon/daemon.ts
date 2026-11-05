// Daemon: JSON-lines IPC for the CLI, session routing to extensions, per-session queues, lifecycle files.
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  type BrowserListResult,
  DEFAULT_WS_PORT,
  isRequestFrame,
  isToolMethod,
  methodEffect,
  PROTOCOL_VERSION,
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
import { VERSION } from "../version";
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

  constructor(private readonly opts: { port: number; foreground: boolean }) {
    this.ext = new ExtensionServer(this.state, (m) => this.log(m));
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

  private async handle(req: RequestFrame): Promise<ResponseFrame> {
    const { id, method } = req;
    const params = (req.params ?? {}) as Record<string, unknown>;
    try {
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
    return { session_id: id, ...result };
  }

  private endSession(id: string, reason: string): void {
    if (!this.state.sessions.delete(id)) return;
    this.state.tombstones.set(id, { reason, at: Date.now() });
    this.log(`session ${id} ended: ${reason}`);
  }

  private forwardTool(method: string, params: Record<string, unknown>): Promise<unknown> {
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
