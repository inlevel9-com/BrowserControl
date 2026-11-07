// IPC client used by every CLI command: connects to the daemon socket, auto-starting the daemon
// unless BCTL_AUTO_START=0. One request per connection keeps the protocol trivially robust.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { connect } from "node:net";
import { DEFAULT_WS_PORT, type RequestFrame, type ResponseFrame, RpcFailure, rpcError } from "@browser-control/protocol";
import { pidAlive, readDaemonInfo } from "./daemon/daemon";
import { bctlHome, logPath, sockPath } from "./paths";
import { remoteCall, remoteTarget } from "./remote";

let seq = 0;

export async function rpc<T = unknown>(method: string, params?: unknown, opts: { timeoutMs?: number; autoStart?: boolean } = {}): Promise<T> {
  if (remoteTarget()) return once<T>(method, params, opts.timeoutMs ?? 90_000);
  const autoStart = opts.autoStart ?? process.env.BCTL_AUTO_START !== "0";
  try {
    return await once<T>(method, params, opts.timeoutMs ?? 90_000);
  } catch (e) {
    if (e instanceof RpcFailure || !autoStart || !isConnRefused(e)) throw e;
  }
  await startDaemonDetached();
  return once<T>(method, params, opts.timeoutMs ?? 90_000);
}

function isConnRefused(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === "ECONNREFUSED" || code === "ENOENT" || code === "ECONNRESET" || code === "EPIPE";
}

/**
 * One request to the daemon: the local socket, or the paired remote daemon when this machine is
 * configured for one (`bctl remote use`, BCTL_REMOTE). `local: true` always uses the socket.
 */
export async function once<T>(method: string, params: unknown, timeoutMs: number, opts: { local?: boolean } = {}): Promise<T> {
  const remote = opts.local ? null : remoteTarget();
  if (remote) {
    const id = `r${process.pid}-${++seq}`;
    const resp = await remoteCall(remote, { id, method, ...(params !== undefined ? { params } : {}) }, timeoutMs);
    if ("error" in resp) throw new RpcFailure(resp.error);
    return resp.result as T;
  }
  return onceLocal<T>(method, params, timeoutMs);
}

function onceLocal<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = `c${process.pid}-${++seq}`;
    const sock = connect(sockPath());
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new RpcFailure(rpcError("timeout", `daemon did not answer ${method} within ${timeoutMs}ms`)));
    }, timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      const req: RequestFrame = { id, method, ...(params !== undefined ? { params } : {}) };
      sock.write(`${JSON.stringify(req)}\n`);
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      sock.end();
      let resp: ResponseFrame;
      try {
        resp = JSON.parse(buf.slice(0, nl)) as ResponseFrame;
      } catch {
        reject(new RpcFailure(rpcError("protocol_error", "malformed response from daemon")));
        return;
      }
      if ("error" in resp) reject(new RpcFailure(resp.error));
      else resolve(resp.result as T);
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export async function daemonReachable(opts: { local?: boolean } = {}): Promise<boolean> {
  try {
    await once("system.ping", undefined, 1500, opts);
    return true;
  } catch {
    return false;
  }
}

/** Spawn `bctl daemon start --foreground` detached, logging to ~/.bctl/daemon.log, and wait until it answers. */
export async function startDaemonDetached(port?: number): Promise<void> {
  const info = readDaemonInfo();
  if (info && pidAlive(info.pid) && (await daemonReachable({ local: true }))) return;
  mkdirSync(bctlHome(), { recursive: true });
  const out = openSync(logPath(), "a");
  const args = [process.argv[1]!, "daemon", "start", "--foreground", "--port", String(port ?? process.env.BCTL_PORT ?? DEFAULT_WS_PORT)];
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", out, out], env: { ...process.env, BCTL_DAEMON_CHILD: "1" }, windowsHide: true });
  child.unref();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await daemonReachable({ local: true })) return;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  const hint = existsSync(logPath()) ? ` (see ${logPath()})` : "";
  throw new RpcFailure(rpcError("internal", `could not start the bctl daemon${hint}`, { reason: "daemon_start_failed", hint: "run `bctl daemon start --foreground` to see the error" }));
}
