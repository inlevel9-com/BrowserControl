// Loopback WebSocket server for extensions: origin check, handshake, RPC forwarding, events.
import { createServer, type Server as HttpServer } from "node:http";
import { EventEmitter } from "node:events";
import {
  DAEMON_SERVER_ID,
  type Frame,
  type HandshakeParams,
  type HandshakeResult,
  isEventFrame,
  isRequestFrame,
  isResponseFrame,
  PROTOCOL_VERSION,
  protocolCompatible,
  type RpcError,
  RpcFailure,
  rpcError,
} from "@browser-control/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { VERSION } from "../version";
import { browserIcon } from "./browser-icon";
import { identifyPeer } from "./process-identity";
import type { BrowserClient, DaemonState } from "./state";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const LIVENESS_TIMEOUT_MS = 75_000;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: RpcFailure) => void;
  timer: ReturnType<typeof setTimeout>;
  instanceId: string;
}

export interface WsServerEvents {
  "browser.connected": (b: BrowserClient) => void;
  "browser.disconnected": (b: BrowserClient, reason: string) => void;
  event: (b: BrowserClient, event: string, payload: unknown) => void;
}

export class ExtensionServer extends EventEmitter {
  private http: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private allowedExtensionIds: Set<string> | null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly state: DaemonState,
    private readonly log: (msg: string) => void,
  ) {
    super();
    const ids = process.env.BCTL_EXTENSION_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
    this.allowedExtensionIds = ids?.length ? new Set(ids) : null;
  }

  async listen(port: number): Promise<number> {
    this.http = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ server: DAEMON_SERVER_ID, version: VERSION, protocol_version: PROTOCOL_VERSION }));
    });
    this.wss = new WebSocketServer({
      server: this.http,
      verifyClient: (info: { origin?: string }) => {
        const origin = info.origin ?? "";
        const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
        if (!m) {
          this.log(`rejecting websocket from origin ${JSON.stringify(origin)}`);
          return false;
        }
        if (this.allowedExtensionIds && !this.allowedExtensionIds.has(m[1]!)) {
          this.log(`rejecting extension ${m[1]} (not in BCTL_EXTENSION_IDS)`);
          return false;
        }
        return true;
      },
    });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req.socket.remotePort ?? 0, req.headers.origin ?? ""));
    this.wss.on("error", (e) => this.log(`ws server error: ${e.message}`));
    await new Promise<void>((resolve, reject) => {
      this.http!.once("error", (e: NodeJS.ErrnoException) => {
        reject(e.code === "EADDRINUSE" ? new Error(`port ${port} is already in use; pick another with --port or BCTL_PORT`) : e);
      });
      this.http!.listen(port, "127.0.0.1", () => resolve());
    });
    this.livenessTimer = setInterval(() => this.reapSilent(), 15_000);
    const addr = this.http.address();
    return typeof addr === "object" && addr ? addr.port : port;
  }

  async close(): Promise<void> {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    for (const c of this.wss?.clients ?? []) c.close(1001, "daemon shutting down");
    await new Promise<void>((r) => this.wss?.close(() => r()));
    await new Promise<void>((r) => this.http?.close(() => r()));
  }

  private onConnection(ws: WebSocket, remotePort: number, origin: string): void {
    let client: BrowserClient | null = null;
    const hsTimer = setTimeout(() => {
      if (!client) ws.close(4001, "handshake timeout");
    }, HANDSHAKE_TIMEOUT_MS);

    ws.on("message", (data) => {
      let frame: Frame;
      try {
        frame = JSON.parse(data.toString()) as Frame;
      } catch {
        return;
      }
      if (!client) {
        if (isRequestFrame(frame) && frame.method === "system.handshake") {
          clearTimeout(hsTimer);
          void this.handshake(ws, frame.id, frame.params as HandshakeParams, remotePort, origin).then((c) => {
            client = c;
          });
        } else if (isRequestFrame(frame)) {
          ws.send(JSON.stringify({ id: frame.id, error: rpcError("protocol_error", "first frame must be system.handshake") }));
        }
        return;
      }
      client.lastSeen = Date.now();
      if (isResponseFrame(frame)) {
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        if ("error" in frame) p.reject(new RpcFailure(frame.error));
        else p.resolve(frame.result);
      } else if (isEventFrame(frame)) {
        if (frame.event !== "system.heartbeat") this.emit("event", client, frame.event, frame.payload);
      } else if (isRequestFrame(frame)) {
        if (frame.method === "system.ping") ws.send(JSON.stringify({ id: frame.id, result: { pong: true } }));
        else ws.send(JSON.stringify({ id: frame.id, error: rpcError("unknown_method", `daemon does not accept ${frame.method} from extensions`) }));
      }
    });

    ws.on("close", (code, reason) => {
      clearTimeout(hsTimer);
      if (!client) return;
      const c = client;
      client = null;
      if (this.state.browsers.get(c.instanceId) === c) this.state.browsers.delete(c.instanceId);
      for (const [id, p] of this.pending) {
        if (p.instanceId === c.instanceId) {
          this.pending.delete(id);
          clearTimeout(p.timer);
          p.reject(new RpcFailure(rpcError("browser_disconnected", `browser ${c.instanceId} disconnected during the call`)));
        }
      }
      this.emit("browser.disconnected", c, `${code} ${reason.toString()}`.trim());
    });
    ws.on("error", (e) => this.log(`ws error: ${e.message}`));
  }

  private async handshake(ws: WebSocket, id: string, p: HandshakeParams, remotePort: number, origin: string): Promise<BrowserClient | null> {
    if (!p || typeof p.instance_id !== "string" || typeof p.protocol_version !== "string") {
      ws.send(JSON.stringify({ id, error: rpcError("invalid_params", "handshake requires instance_id and protocol_version") }));
      ws.close(4002, "bad handshake");
      return null;
    }
    if (!protocolCompatible(p.protocol_version)) {
      ws.send(JSON.stringify({ id, error: rpcError("version_mismatch", `extension protocol ${p.protocol_version} is incompatible with daemon protocol ${PROTOCOL_VERSION}; update the extension or the CLI`) }));
      ws.close(4003, "version mismatch");
      return null;
    }
    const existing = this.state.browsers.get(p.instance_id);
    if (existing && existing.ws !== ws) {
      // Same profile reconnected (service worker restart). Replace the stale socket.
      try {
        existing.ws.close(4004, "replaced by a newer connection");
      } catch {
        /* ignore */
      }
    }
    const processId = await identifyPeer(remotePort);
    const client: BrowserClient = {
      instanceId: p.instance_id,
      label: typeof p.label === "string" ? p.label.slice(0, 64) : "",
      browser: p.browser ?? { name: "chromium", version: "unknown" },
      extensionVersion: String(p.version ?? ""),
      protocolVersion: p.protocol_version,
      process: processId,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      ws,
    };
    this.state.browsers.set(client.instanceId, client);
    const result: HandshakeResult = { server: DAEMON_SERVER_ID, version: VERSION, protocol_version: PROTOCOL_VERSION, ...(processId ? { process: processId } : {}) };
    ws.send(JSON.stringify({ id, result }));
    this.log(`browser connected: ${client.instanceId} ${client.browser.name}/${client.browser.version} process=${processId?.name ?? "?"} origin=${origin}`);
    this.emit("browser.connected", client);
    // Hand the popup the browser's real icon from its local install (best effort, after the handshake).
    void browserIcon(processId).then((icon) => {
      if (icon && client.ws.readyState === WebSocket.OPEN) void this.call(client, "system.browser_icon", { icon, name: processId?.name }, 5_000).catch(() => undefined);
    });
    return client;
  }

  /** Forward an RPC to one extension and await its response. */
  call(client: BrowserClient, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = `d${++this.seq}`;
    return new Promise((resolve, reject) => {
      if (client.ws.readyState !== WebSocket.OPEN) {
        reject(new RpcFailure(rpcError("browser_disconnected", `browser ${client.instanceId} is not connected`)));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try {
          client.ws.send(JSON.stringify({ id: `c${id}`, method: "cancel", params: { rpc_id: id } }));
        } catch {
          /* ignore */
        }
        reject(new RpcFailure(rpcError("timeout", `${method} timed out after ${timeoutMs}ms`, { reason: "extension_timeout", hint: "the page may be busy or blocked by a native dialog; check `bctl dialog status`" })));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, instanceId: client.instanceId });
      client.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private reapSilent(): void {
    const now = Date.now();
    for (const c of Array.from(this.state.browsers.values())) {
      if (now - c.lastSeen > LIVENESS_TIMEOUT_MS) {
        this.log(`reaping silent browser ${c.instanceId}`);
        try {
          c.ws.terminate();
        } catch {
          /* ignore */
        }
      } else if (now - c.lastSeen > LIVENESS_TIMEOUT_MS / 2) {
        try {
          c.ws.ping();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export function asRpcError(e: unknown): RpcError {
  if (e instanceof RpcFailure) return e.error;
  return rpcError("internal", String((e as Error)?.message ?? e));
}
