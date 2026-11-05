import { test } from "node:test";
import assert from "node:assert/strict";
import {
  browserFromProcessName,
  browserFromUserAgent,
  compareProtocol,
  isEventFrame,
  isRequestFrame,
  isResponseFrame,
  methodEffect,
  parseRef,
} from "./index.ts";

test("frame guards", () => {
  assert.ok(isRequestFrame({ id: "1", method: "system.ping" }));
  assert.ok(isResponseFrame({ id: "1", result: {} }));
  assert.ok(isResponseFrame({ id: "1", error: { code: "timeout", message: "x" } }));
  assert.ok(isEventFrame({ event: "system.heartbeat" }));
  assert.ok(!isResponseFrame({ id: "1", method: "x", result: {} }));
});

test("browser detection", () => {
  assert.equal(browserFromUserAgent("Mozilla/5.0 Chrome/156.0.0.0 Whale/5.39.412.57 Safari/537.36").name, "whale");
  assert.equal(browserFromUserAgent("Mozilla/5.0 Chrome/156.0 Edg/156.0").name, "edge");
  assert.equal(browserFromUserAgent("Mozilla/5.0 Chrome/156.0 Safari/537.36", ["Brave", "Chromium"]).name, "brave");
  assert.equal(browserFromUserAgent("Mozilla/5.0 Chrome/156.0 Safari/537.36").name, "chrome");
  assert.equal(browserFromProcessName("Arc"), "arc");
  assert.equal(browserFromProcessName("Dia Helper"), "dia");
  assert.equal(browserFromProcessName("Google Chrome"), "chrome");
  assert.equal(browserFromProcessName("Brave Browser"), "brave");
});

test("refs, effects, versions", () => {
  assert.equal(parseRef("@e12"), "e12");
  assert.equal(parseRef("e3"), "e3");
  assert.equal(parseRef("button.primary"), null);
  assert.equal(methodEffect("tool.click"), "mutate");
  assert.equal(methodEffect("tool.snapshot"), "read");
  assert.equal(methodEffect("session.start"), "control");
  assert.equal(compareProtocol("1.0", "1.1"), -1);
});
