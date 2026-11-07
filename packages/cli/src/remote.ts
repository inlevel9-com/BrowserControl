// Remote access: a bctl CLI on another machine (dev box, SSH host, VM) talks to the daemon on the
// machine where the browser runs.
//
// Transport: TCP. Authentication and encryption come from a 32-byte secret shared at pairing time:
//   C → S  {"proto":"bctl-remote/1","client_id":…,"nonce":<32 random bytes>}\n
//   S → C  {"proto":"bctl-remote/1","nonce":<32 random bytes>}\n
//   keys   = HKDF-SHA256(secret, salt = nonce_c ‖ nonce_s, "bctl-remote/1 keys") → 2 × 32 bytes
//   then   length-prefixed AES-256-GCM frames, IV = direction ‖ 64-bit counter.
// Both nonces are fresh, so every connection has its own keys; a client that does not hold the
// secret cannot produce a frame the daemon accepts, and a fake daemon cannot answer one.
// One request and one response per connection, like the local socket.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { DEFAULT_REMOTE_PORT, type RequestFrame, type ResponseFrame, RpcFailure, rpcError } from "@browser-control/protocol";
import { remoteClientConfigPath, remoteServerConfigPath } from "./paths.ts";

export const REMOTE_PROTO = "bctl-remote/1";
const AAD = Buffer.from(REMOTE_PROTO);
const MAX_FRAME = 96 * 1024 * 1024;
const HELLO_MAX = 4096;

// --------------------------------------------------------------------------- pairing strings

export interface Pairing {
  clientId: string;
  secret: Buffer;
  host: string;
  port: number;
}

/** `bctl1.<client_id>.<secret b64url>@<host>:<port>` */
export function formatPairing(p: Pairing): string {
  const host = p.host.includes(":") && !p.host.startsWith("[") ? `[${p.host}]` : p.host;
  return `bctl1.${p.clientId}.${p.secret.toString("base64url")}@${host}:${p.port}`;
}

export function parsePairing(s: string): Pairing {
  const m = /^bctl1\.([A-Za-z0-9_-]{4,64})\.([A-Za-z0-9_-]{40,64})@(\[[^\]]+\]|[^:@\s]+):(\d{1,5})$/.exec(s.trim());
  if (!m) throw new Error("not a bctl pairing string (expected bctl1.<id>.<secret>@<host>:<port>)");
  const secret = Buffer.from(m[2]!, "base64url");
  if (secret.length !== 32) throw new Error("pairing secret must be 32 bytes");
  const port = Number(m[4]);
  if (!(port > 0 && port < 65536)) throw new Error("pairing port out of range");
  return { clientId: m[1]!, secret, host: m[3]!.replace(/^\[|\]$/g, ""), port };
}

// --------------------------------------------------------------------------- crypto

export function deriveKeys(secret: Buffer, clientNonce: Buffer, serverNonce: Buffer): { c2s: Buffer; s2c: Buffer } {
  const okm = Buffer.from(hkdfSync("sha256", secret, Buffer.concat([clientNonce, serverNonce]), Buffer.from(`${REMOTE_PROTO} keys`), 64));
  return { c2s: okm.subarray(0, 32), s2c: okm.subarray(32, 64) };
}

/** One direction of an AES-256-GCM channel with strictly increasing counters. */
export class Sealer {
  private counter = 0n;
  private readonly key: Buffer;
  private readonly dir: number;
  constructor(key: Buffer, dir: number) {
    this.key = key;
    this.dir = dir;
  }
  private iv(): Buffer {
    const iv = Buffer.alloc(12);
    iv.writeUInt32BE(this.dir, 0);
    iv.writeBigUInt64BE(this.counter, 4);
    this.counter++;
    return iv;
  }
  seal(plain: Buffer): Buffer {
    const iv = this.iv();
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(AAD);
    const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    return Buffer.concat([len, body]);
  }
  /** Open one frame body (without the length prefix). Throws on any tampering. */
  open(body: Buffer): Buffer {
    if (body.length < 16) throw new Error("frame too short");
    const iv = this.iv();
    const d = createDecipheriv("aes-256-gcm", this.key, iv);
    d.setAAD(AAD);
    d.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
  }
}

/** Splits a byte stream into: first a JSON hello line, then length-prefixed frames. */
export class StreamReader {
  private buf = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private ended: Error | null = null;
  constructor(sock: Socket) {
    sock.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.wake();
    });
    sock.on("end", () => this.fail(new Error("connection closed")));
    sock.on("close", () => this.fail(new Error("connection closed")));
    sock.on("error", (e) => this.fail(e));
  }
  private fail(e: Error): void {
    if (!this.ended) this.ended = e;
    this.wake();
  }
  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
  private async more(): Promise<void> {
    if (this.ended) throw this.ended;
    await new Promise<void>((r) => this.waiters.push(r));
  }
  async line(): Promise<string> {
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl >= 0) {
        const s = this.buf.subarray(0, nl).toString("utf8");
        this.buf = this.buf.subarray(nl + 1);
        return s;
      }
      if (this.buf.length > HELLO_MAX) throw new Error("hello too long");
      await this.more();
    }
  }
  async frame(): Promise<Buffer> {
    for (;;) {
      if (this.buf.length >= 4) {
        const len = this.buf.readUInt32BE(0);
        if (len > MAX_FRAME) throw new Error("frame too large");
        if (this.buf.length >= 4 + len) {
          const body = this.buf.subarray(4, 4 + len);
          this.buf = this.buf.subarray(4 + len);
          return body;
        }
      }
      await this.more();
    }
  }
}

// --------------------------------------------------------------------------- client

/** Send one request to a remote daemon and return its response frame. */
export function remoteCall(p: Pairing, req: RequestFrame, timeoutMs: number): Promise<ResponseFrame> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: p.host, port: p.port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new RpcFailure(rpcError("timeout", `remote daemon ${p.host}:${p.port} did not answer ${req.method} within ${timeoutMs}ms`)));
    }, timeoutMs);
    const reader = new StreamReader(sock);
    let connected = false;
    sock.once("error", (e) => {
      if (connected) return; // handled by the reader
      clearTimeout(timer);
      reject(Object.assign(new Error(`cannot reach remote daemon ${p.host}:${p.port}: ${e.message}`), { code: (e as NodeJS.ErrnoException).code, remote: true }));
    });
    sock.once("connect", () => {
      connected = true;
      void (async () => {
        try {
          const nc = randomBytes(32);
          sock.write(`${JSON.stringify({ proto: REMOTE_PROTO, client_id: p.clientId, nonce: nc.toString("base64") })}\n`);
          const hello = JSON.parse(await reader.line()) as { proto?: string; nonce?: string; error?: string };
          if (hello.error) throw new RpcFailure(rpcError("permission_denied", `remote daemon refused the connection: ${hello.error}`, { reason: "remote_refused" }));
          if (hello.proto !== REMOTE_PROTO || !hello.nonce) throw new RpcFailure(rpcError("protocol_error", "remote daemon spoke an unknown protocol", { reason: "remote_protocol" }));
          const keys = deriveKeys(p.secret, nc, Buffer.from(hello.nonce, "base64"));
          const out = new Sealer(keys.c2s, 1);
          const inn = new Sealer(keys.s2c, 2);
          sock.write(out.seal(Buffer.from(JSON.stringify(req))));
          let body: Buffer;
          try {
            body = await reader.frame();
          } catch {
            throw new RpcFailure(rpcError("permission_denied", "remote daemon closed the connection; the pairing was probably revoked or is wrong", { reason: "remote_auth_failed", hint: "pair again: on the browser machine run `bctl remote pair`, then `bctl remote use <pairing>` here" }));
          }
          let plain: Buffer;
          try {
            plain = inn.open(body);
          } catch {
            throw new RpcFailure(rpcError("permission_denied", "remote daemon could not prove it holds the pairing secret", { reason: "remote_auth_failed" }));
          }
          clearTimeout(timer);
          sock.end();
          resolve(JSON.parse(plain.toString("utf8")) as ResponseFrame);
        } catch (e) {
          clearTimeout(timer);
          sock.destroy();
          reject(e);
        }
      })();
    });
  });
}

/** Pairing the CLI should use, from BCTL_REMOTE or ~/.bctl/remote-client.json. `BCTL_REMOTE=off` forces local. */
export function remoteTarget(): Pairing | null {
  const env = process.env.BCTL_REMOTE?.trim();
  if (env) {
    if (/^(off|0|false|local)$/i.test(env)) return null;
    return parsePairing(env);
  }
  const p = remoteClientConfigPath();
  if (!existsSync(p)) return null;
  try {
    const cfg = JSON.parse(readFileSync(p, "utf8")) as { pairing?: string };
    return cfg.pairing ? parsePairing(cfg.pairing) : null;
  } catch {
    return null;
  }
}

export function saveRemoteClient(pairing: string): void {
  parsePairing(pairing);
  writeSecret(remoteClientConfigPath(), { pairing, saved_at: new Date().toISOString() });
}
export function forgetRemoteClient(): boolean {
  const p = remoteClientConfigPath();
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}

// --------------------------------------------------------------------------- server config

export interface RemoteClientRecord {
  client_id: string;
  name: string;
  secret: string;
  created_at: string;
  last_used_at?: string;
}
export interface RemoteServerConfig {
  enabled: boolean;
  host: string;
  port: number;
  clients: RemoteClientRecord[];
}

export function readServerConfig(): RemoteServerConfig {
  const def: RemoteServerConfig = { enabled: false, host: "127.0.0.1", port: DEFAULT_REMOTE_PORT, clients: [] };
  try {
    const c = JSON.parse(readFileSync(remoteServerConfigPath(), "utf8")) as Partial<RemoteServerConfig>;
    return { ...def, ...c, clients: Array.isArray(c.clients) ? c.clients : [] };
  } catch {
    return def;
  }
}
export function writeServerConfig(c: RemoteServerConfig): void {
  writeSecret(remoteServerConfigPath(), c);
}

function writeSecret(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows: ACLs of the user profile apply */
  }
}

export function newClient(name: string): RemoteClientRecord {
  return { client_id: randomBytes(6).toString("base64url"), name, secret: randomBytes(32).toString("base64url"), created_at: new Date().toISOString() };
}

// --------------------------------------------------------------------------- server

export interface RemoteContext {
  clientId: string;
  name: string;
}

export class RemoteServer {
  private server: Server | null = null;
  private address = "";
  private readonly handle: (req: RequestFrame, ctx: RemoteContext) => Promise<ResponseFrame>;
  private readonly log: (m: string) => void;

  constructor(handle: (req: RequestFrame, ctx: RemoteContext) => Promise<ResponseFrame>, log: (m: string) => void) {
    this.handle = handle;
    this.log = log;
  }

  get listening(): string {
    return this.address;
  }

  async listen(host: string, port: number): Promise<string> {
    await this.close();
    const srv = createServer((sock) => void this.onConnection(sock));
    await new Promise<void>((resolve, reject) => {
      srv.once("error", (e: NodeJS.ErrnoException) => reject(e.code === "EADDRINUSE" ? new Error(`remote port ${port} is already in use; choose another with \`bctl remote enable --port\``) : e));
      srv.listen(port, host, () => resolve());
    });
    this.server = srv;
    const a = srv.address();
    this.address = typeof a === "object" && a ? `${a.address.includes(":") ? `[${a.address}]` : a.address}:${a.port}` : `${host}:${port}`;
    return this.address;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.address = "";
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private async onConnection(sock: Socket): Promise<void> {
    const peer = `${sock.remoteAddress}:${sock.remotePort}`;
    const reader = new StreamReader(sock);
    sock.setTimeout(15_000, () => sock.destroy());
    sock.on("error", () => {});
    try {
      const hello = JSON.parse(await reader.line()) as { proto?: string; client_id?: string; nonce?: string };
      if (hello.proto !== REMOTE_PROTO || typeof hello.client_id !== "string" || typeof hello.nonce !== "string") {
        sock.end(`${JSON.stringify({ error: "unsupported protocol" })}\n`);
        return;
      }
      const nc = Buffer.from(hello.nonce, "base64");
      const ns = randomBytes(32);
      const cfg = readServerConfig();
      const rec = cfg.clients.find((c) => c.client_id === hello.client_id);
      // Unknown clients get the same answer as known ones; they fail at the first frame.
      const secret = rec ? Buffer.from(rec.secret, "base64url") : randomBytes(32);
      sock.write(`${JSON.stringify({ proto: REMOTE_PROTO, nonce: ns.toString("base64") })}\n`);
      if (nc.length !== 32) throw new Error("bad nonce");
      const keys = deriveKeys(secret, nc, ns);
      const inn = new Sealer(keys.c2s, 1);
      const out = new Sealer(keys.s2c, 2);
      let req: RequestFrame;
      try {
        req = JSON.parse(inn.open(await reader.frame()).toString("utf8")) as RequestFrame;
      } catch {
        this.log(`remote: rejected ${peer} (client ${JSON.stringify(hello.client_id).slice(0, 40)}${rec ? "" : ", unknown"}): authentication failed`);
        await new Promise((r) => setTimeout(r, 300));
        sock.destroy();
        return;
      }
      if (!rec) return void sock.destroy();
      sock.setTimeout(0);
      this.touch(rec.client_id);
      const resp = await this.handle(req, { clientId: rec.client_id, name: rec.name });
      sock.end(out.seal(Buffer.from(JSON.stringify(resp))));
    } catch (e) {
      this.log(`remote: connection from ${peer} failed: ${(e as Error).message}`);
      sock.destroy();
    }
  }

  private lastTouch = new Map<string, number>();
  private touch(clientId: string): void {
    const now = Date.now();
    if (now - (this.lastTouch.get(clientId) ?? 0) < 60_000) return;
    this.lastTouch.set(clientId, now);
    const cfg = readServerConfig();
    const c = cfg.clients.find((x) => x.client_id === clientId);
    if (!c) return;
    c.last_used_at = new Date(now).toISOString();
    writeServerConfig(cfg);
  }
}
