import { test } from "node:test";
import assert from "node:assert/strict";
import { DaemonState, displayBrowserName, type BrowserClient } from "./daemon/state.ts";

function client(id: string, name: string, label = "", procBrowser?: string): BrowserClient {
  return {
    instanceId: id,
    label,
    browser: { name, version: "156" },
    extensionVersion: "0.1.0",
    protocolVersion: "1.0",
    process: procBrowser ? { pid: 1, name: procBrowser, browser: procBrowser } : undefined,
    connectedAt: 0,
    lastSeen: 0,
    ws: {} as never,
  };
}

test("selectBrowser", () => {
  const s = new DaemonState();
  assert.equal((s.selectBrowser() as { code: string }).code, "no_browser_connected");
  s.browsers.set("a", client("a", "chrome", "work"));
  assert.equal((s.selectBrowser() as { client: BrowserClient }).client.instanceId, "a");
  s.browsers.set("b", client("b", "chrome", "", "arc"));
  assert.equal((s.selectBrowser() as { code: string }).code, "multiple_browsers_online");
  assert.equal((s.selectBrowser("work") as { client: BrowserClient }).client.instanceId, "a");
  assert.equal((s.selectBrowser("arc") as { client: BrowserClient }).client.instanceId, "b");
  assert.equal((s.selectBrowser("B") as { client: BrowserClient }).client.instanceId, "b");
  assert.equal((s.selectBrowser("edge") as { code: string }).code, "not_found");
  assert.equal(displayBrowserName(client("x", "chrome", "", "dia")), "Dia");
});

test("session ids are 4 lowercase letters and unique", () => {
  const s = new DaemonState();
  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const id = s.newSessionId();
    assert.match(id, /^[a-z]{4}$/);
    s.tombstones.set(id, { reason: "x", at: 0 });
    ids.add(id);
  }
  assert.equal(ids.size, 200);
});
