import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveKeys, formatPairing, parsePairing, remoteCall, RemoteServer, Sealer } from "./remote.ts";

test("pairing strings round-trip, including IPv6 hosts", () => {
  const secret = randomBytes(32);
  for (const host of ["127.0.0.1", "devbox.tailnet.ts.net", "::1"]) {
    const s = formatPairing({ clientId: "abcDEF12", secret, host, port: 52811 });
    const p = parsePairing(s);
    assert.equal(p.clientId, "abcDEF12");
    assert.equal(p.host, host);
    assert.equal(p.port, 52811);
    assert.ok(p.secret.equals(secret));
  }
  assert.throws(() => parsePairing("bctl1.x.y@h:1"));
  assert.throws(() => parsePairing("https://example.com"));
});

test("sealed frames open only with the right key, in order, untampered", () => {
  const secret = randomBytes(32);
  const nc = randomBytes(32);
  const ns = randomBytes(32);
  const a = deriveKeys(secret, nc, ns);
  const b = deriveKeys(secret, nc, ns);
  assert.ok(a.c2s.equals(b.c2s) && !a.c2s.equals(a.s2c));
  const tx = new Sealer(a.c2s, 1);
  const rx = new Sealer(b.c2s, 1);
  const f1 = tx.seal(Buffer.from("hello"));
  const f2 = tx.seal(Buffer.from("world"));
  assert.equal(rx.open(f1.subarray(4)).toString(), "hello");
  assert.equal(rx.open(f2.subarray(4)).toString(), "world");
  // Replay / reorder fails: the counter moved on.
  assert.throws(() => new Sealer(b.c2s, 1).open(f2.subarray(4)));
  // Tampering fails.
  const bad = Buffer.from(f1.subarray(4));
  bad[0] = bad[0]! ^ 1;
  assert.throws(() => new Sealer(b.c2s, 1).open(bad));
  // Different nonce → different keys.
  const other = deriveKeys(secret, randomBytes(32), ns);
  assert.throws(() => new Sealer(other.c2s, 1).open(f1.subarray(4)));
});

test("remote server answers paired clients and rejects others", async () => {
  const home = mkdtempSync(join(tmpdir(), "bctl-remote-test-"));
  const prev = process.env.BCTL_HOME;
  process.env.BCTL_HOME = home;
  try {
    const secret = randomBytes(32);
    writeFileSync(join(home, "remote.json"), JSON.stringify({ enabled: true, host: "127.0.0.1", port: 0, clients: [{ client_id: "client01", name: "devbox", secret: secret.toString("base64url"), created_at: new Date().toISOString() }] }));
    const seen: string[] = [];
    const srv = new RemoteServer(async (req, ctx) => {
      seen.push(`${ctx.name}:${req.method}`);
      return { id: req.id, result: { pong: true } };
    }, () => {});
    const addr = await srv.listen("127.0.0.1", 0);
    const port = Number(addr.split(":").pop());
    const ok = await remoteCall({ clientId: "client01", secret, host: "127.0.0.1", port }, { id: "1", method: "system.ping" }, 5000);
    assert.deepEqual(ok, { id: "1", result: { pong: true } });
    assert.deepEqual(seen, ["devbox:system.ping"]);
    await assert.rejects(remoteCall({ clientId: "client01", secret: randomBytes(32), host: "127.0.0.1", port }, { id: "2", method: "system.ping" }, 5000), /remote_auth_failed|closed|could not prove/);
    await assert.rejects(remoteCall({ clientId: "nobody01", secret, host: "127.0.0.1", port }, { id: "3", method: "system.ping" }, 5000));
    assert.equal(seen.length, 1);
    await srv.close();
  } finally {
    if (prev === undefined) delete process.env.BCTL_HOME;
    else process.env.BCTL_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
