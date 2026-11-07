import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePowershellPeer, powershellPeerScript } from "./daemon/process-identity.ts";
import { sockPath } from "./paths.ts";
import { windowsBrowserPaths } from "./win-paths.ts";

test("PowerShell peer output parses into a browser identity", () => {
  assert.deepEqual(parsePowershellPeer("8812|chrome|C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\r\n"), {
    pid: 8812,
    name: "chrome",
    path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    browser: "chrome",
  });
  assert.equal(parsePowershellPeer("WARNING: something\r\n77|msedge|C:\\x\\msedge.exe")?.browser, "edge");
  assert.equal(parsePowershellPeer("12|whale|")?.browser, "whale");
  assert.equal(parsePowershellPeer("5|brave|C:\\Users\\a\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe")?.browser, "brave");
  assert.equal(parsePowershellPeer("9|Arc|C:\\Program Files\\WindowsApps\\TheBrowserCompany.Arc\\Arc.exe")?.browser, "arc");
  assert.equal(parsePowershellPeer(""), undefined);
  assert.equal(parsePowershellPeer("garbage"), undefined);
});

test("PowerShell script embeds only an integer port", () => {
  const s = powershellPeerScript(51234.9);
  assert.match(s, /-LocalPort 51234 /);
  assert.ok(!s.includes("51234.9"));
});

test("Windows IPC uses a per-user named pipe", () => {
  const prev = process.env.BCTL_HOME;
  delete process.env.BCTL_HOME;
  try {
    assert.match(sockPath("win32"), /^\\\\\.\\pipe\\bctl-[^\\]+$/);
    process.env.BCTL_HOME = "C:\\temp\\bctl";
    const custom = sockPath("win32");
    assert.match(custom, /^\\\\\.\\pipe\\bctl-[^\\]+-[0-9a-f]{16}$/);
    assert.notEqual(custom, (() => { process.env.BCTL_HOME = "C:\\other"; return sockPath("win32"); })());
  } finally {
    if (prev === undefined) delete process.env.BCTL_HOME;
    else process.env.BCTL_HOME = prev;
  }
});

test("Windows browser locations cover Program Files and Local AppData", () => {
  const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" };
  const chrome = windowsBrowserPaths("chrome", env);
  assert.ok(chrome.includes("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"));
  assert.ok(chrome.includes("C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"));
  assert.ok(windowsBrowserPaths("whale", env).some((p) => p.endsWith("Naver Whale\\Application\\whale.exe")));
  assert.deepEqual(windowsBrowserPaths("arc", env), []);
});
