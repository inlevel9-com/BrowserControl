// End-to-end: real Chromium + unpacked extension + daemon + bctl CLI against a local fixture site.
// Usage: node tests/e2e/run.mjs [--headful] [--browser "/Applications/Whale.app/Contents/MacOS/Whale"]
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const extDist = join(tmpdir(), `bctl-e2e-ext-${process.pid}`);
const bctlBin = resolve(root, "packages/cli/bin/bctl.js");
const args = process.argv.slice(2);
const headful = args.includes("--headful");
const browserArg = args.includes("--browser") ? args[args.indexOf("--browser") + 1] : null;
// Pick a free loopback port for the daemon so parallel/leaked runs never collide.
const PORT = await new Promise((r) => { const srv = createServer(); srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => r(p)); }); });
const tmp = join(tmpdir(), `bctl-e2e-${process.pid}`);
const home = join(tmp, "home");
const profile = join(tmp, "profile");
const downloadsDir = join(tmp, "downloads");
mkdirSync(home, { recursive: true });
mkdirSync(join(profile, "Default"), { recursive: true });
mkdirSync(downloadsDir, { recursive: true });
// Keep test downloads out of the real ~/Downloads and never prompt.
writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true }, savefile: { default_directory: downloadsDir } }));

// Build a private copy of the extension whose default daemon port is the e2e port.
await promisify(execFile)(process.execPath, [resolve(root, "packages/extension/build.mjs")], { env: { ...process.env, BCTL_EXT_OUT: extDist, BCTL_DAEMON_WS_URL: `ws://127.0.0.1:${PORT}` } });
assert.ok(existsSync(join(extDist, "manifest.json")), "extension build failed");
assert.ok(existsSync(resolve(root, "packages/cli/dist/bctl.mjs")), "build the CLI first: pnpm build");

function playwrightCache() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === "darwin") return join(homedir(), "Library/Caches/ms-playwright");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "ms-playwright");
  return join(homedir(), ".cache/ms-playwright");
}

function findBrowser() {
  if (browserArg) return browserArg;
  // Branded Google Chrome 137+ ignores --load-extension; prefer Chromium / Chrome for Testing builds.
  const pw = playwrightCache();
  const inBuild = [
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
    "chrome-win64/chrome.exe",
    "chrome-win/chrome.exe",
  ];
  const pwChromium = existsSync(pw)
    ? readdirSync(pw)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
        .flatMap((d) => inBuild.map((p) => join(pw, d, p)))
        .find((p) => existsSync(p))
    : undefined;
  const candidates =
    process.platform === "darwin"
      ? [pwChromium, "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
      : process.platform === "win32"
        ? [pwChromium]
        : [pwChromium, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/opt/google/chrome/chrome"];
  const found = candidates.filter(Boolean).find((p) => existsSync(p));
  assert.ok(found, "no Chromium browser found; run `npx playwright install chromium` or pass --browser <path>");
  return found;
}

// ---- fixture site
const fixtures = join(here, "fixtures");
const site = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/download/report.csv") {
    res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="report.csv"' });
    res.end("name,score\nAnn,90\n");
    return;
  }
  if (url.pathname === "/api/ping") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  const file = join(fixtures, url.pathname === "/" ? "index.html" : url.pathname);
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end("nope");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(readFileSync(file));
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${site.address().port}`;

// ---- daemon (foreground, own home, own port)
const env = { ...process.env, BCTL_HOME: home, BCTL_AUTO_START: "0", BCTL_PORT: String(PORT) };
const daemon = spawn(process.execPath, [bctlBin, "daemon", "start", "--foreground", "--port", String(PORT)], { env, stdio: ["ignore", "pipe", "pipe"] });
let daemonLog = "";
daemon.stdout.on("data", (d) => (daemonLog += d));
daemon.stderr.on("data", (d) => (daemonLog += d));

const execFileP = promisify(execFile);
async function bctl(...a) {
  try {
    const { stdout } = await execFileP(process.execPath, [bctlBin, "--json", ...a], { env, maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(`bctl ${a.join(" ")} failed: ${(e.stdout || "").trim()} ${(e.stderr || "").trim()}`);
  }
}
async function bctlFail(...a) {
  return bctlFailEnv(env, ...a);
}
async function bctlFailEnv(e2, ...a) {
  try {
    await execFileP(process.execPath, [bctlBin, "--json", ...a], { env: e2 });
  } catch (e) {
    try {
      return JSON.parse(e.stdout).error;
    } catch {
      return { code: "?", message: `${e.stdout} ${e.stderr}` };
    }
  }
  throw new Error(`expected failure for bctl ${a.join(" ")}`);
}
async function bctlEnv(e2, ...a) {
  try {
    const { stdout } = await execFileP(process.execPath, [bctlBin, "--json", ...a], { env: e2, maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(`bctl ${a.join(" ")} failed: ${(e.stdout || "").trim()} ${(e.stderr || "").trim()}`);
  }
}
function freePort() {
  return new Promise((r) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => r(p));
    });
  });
}

/** Minimal MCP stdio client. */
function mcpClient(extraArgs = []) {
  const child = spawn(process.execPath, [bctlBin, "mcp", ...extraArgs], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let stderr = "";
  const waiting = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  child.stderr.on("data", (d) => (stderr += d));
  let id = 0;
  return {
    child,
    get stderr() {
      return stderr;
    },
    request(method, params = {}, timeout = 60000) {
      const myId = ++id;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`MCP ${method} timed out; stderr: ${stderr}`)), timeout);
        waiting.set(myId, (m) => {
          clearTimeout(t);
          resolve(m);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: myId, method, params })}\n`);
      });
    },
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    close() {
      child.stdin.end();
      return new Promise((r) => child.on("exit", r));
    },
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < 50; i++) {
  try {
    await bctl("status");
    break;
  } catch {
    await sleep(100);
  }
}

// ---- browser with the unpacked extension, pointed at our daemon port via build-time default override:
// the extension reads the port from storage; a fresh profile has none, so we pass it with a managed policy-free trick:
// we start Chrome once, then set the port through the popup page? Simpler: the extension's default port is 52810,
// so for e2e we build with BCTL_DAEMON_WS_URL. Here we instead run the daemon on the default port when free.
const browser = findBrowser();
const chromeArgs = [
  `--user-data-dir=${profile}`,
  `--load-extension=${extDist}`,
  `--disable-extensions-except=${extDist}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=TranslateUI,OptimizationHints",
  "--window-size=1200,900",
  // GitHub's Ubuntu runners restrict user namespaces, which Chromium's sandbox needs.
  ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
  ...(headful ? [] : ["--headless=new"]),
  "about:blank",
];
console.log(`browser: ${browser}`);
const chrome = spawn(browser, chromeArgs, { stdio: "ignore" });

let results = { passed: 0, failed: 0 };
async function step(name, fn) {
  try {
    await fn();
    results.passed++;
    console.log(`✔ ${name}`);
  } catch (e) {
    results.failed++;
    console.log(`✘ ${name}\n   ${e.stack?.split("\n").slice(0, 3).join("\n   ")}`);
  }
}

try {
  await step("extension connects to daemon", async () => {
    for (let i = 0; i < 100; i++) {
      const s = await bctl("status");
      if (s.browsers?.length) {
        console.log(`   browser: ${s.browsers[0].process?.browser ?? s.browsers[0].browser.name} (ua=${s.browsers[0].browser.name}, process=${s.browsers[0].process?.name ?? "?"})`);
        // Process identity is how Arc/Dia get named: check the OS lookup (lsof / Get-NetTCPConnection) works here.
        if (process.platform === "darwin" || process.platform === "win32") {
          assert.equal(s.browsers[0].process?.browser, "chrome", `process identity not resolved: ${JSON.stringify(s.browsers[0].process)}`);
        }
        return;
      }
      await sleep(200);
    }
    throw new Error(`extension never connected\n${daemonLog}`);
  });

  let sid;
  await step("session start", async () => {
    const r = await bctl("session", "start");
    assert.match(r.session_id, /^[a-z]{4}$/);
    assert.ok(r.agent_window_id > 0);
    sid = r.session_id;
  });
  const S = () => ["--session", sid];

  await step("navigate + snapshot with refs", async () => {
    const nav = await bctl("open", `${base}/`, ...S());
    assert.equal(nav.status, "complete");
    assert.equal(nav.title, "BrowserControl Fixture");
    const snap = await bctl("snapshot", ...S());
    assert.ok(snap.ref_count >= 8, `ref_count ${snap.ref_count}`);
    assert.match(snap.text, /textbox "Search" @e\d+/);
    assert.match(snap.text, /link "Second page" @e\d+ \[href="\/second.html"\]/);
    assert.match(snap.text, /combobox "" @e\d+ \[options=\[\*r,g,b\]\]|combobox "[^"]*" @e\d+ \[options=\[\*r,g,b\]\]/);
    assert.ok(!snap.text.includes("hidden-input"));
  });

  await step("find", async () => {
    const r = await bctl("find", "alert", ...S());
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].role, "button");
  });

  await step("fill via trusted input fires page handlers", async () => {
    const snap = await bctl("snapshot", ...S());
    const ref = /textbox "Search" @(e\d+)/.exec(snap.text)[1];
    const r = await bctl("fill", `@${ref}`, "hello world", ...S());
    assert.equal(r.via, "cdp");
    const t = await bctl("text", "#status", ...S());
    assert.equal(t.text, "typed:hello world");
  });

  await step("press Enter is trusted", async () => {
    await bctl("press", "Enter", "--target", "#q", ...S());
    const t = await bctl("text", "#status", ...S());
    assert.equal(t.text, "enter:true");
  });

  await step("click is trusted", async () => {
    const r = await bctl("click", "#go", ...S());
    assert.equal(r.via, "cdp");
    // form submits → second page with query
    await bctl("wait", "nav", "--url", "second.html", ...S());
    const t = await bctl("text", "#query", ...S());
    assert.equal(t.text, "query=?q=hello+world&color=r");
  });

  await step("back + select + check", async () => {
    const b = await bctl("back", ...S());
    assert.match(b.url, /\/$/);
    const r = await bctl("select", "#color", "Blue", ...S());
    assert.deepEqual(r.selected, ["b"]);
    const c = await bctl("check", "#agree", ...S());
    assert.equal(c.checked, true);
  });

  await step("contenteditable fill", async () => {
    await bctl("fill", "#editor", "new content", ...S());
    const t = await bctl("text", "#editor", ...S());
    assert.equal(t.text, "new content");
  });

  await step("scroll + scroll-to", async () => {
    const r = await bctl("scroll", "--bottom", ...S());
    assert.equal(r.at_bottom, true);
    const top = await bctl("scroll", "--top", ...S());
    assert.equal(top.scroll_y, 0);
    await bctl("scroll-to", "#bottom", ...S());
  });

  await step("alert dialog lifecycle", async () => {
    const r = await bctl("click", "#alerter", ...S());
    assert.equal(r.dialog?.type, "alert");
    const blocked = await bctlFail("snapshot", ...S());
    assert.equal(blocked.code, "dialog_pending");
    const st = await bctl("dialog", "status", ...S());
    assert.equal(st.dialog.message, "hello from fixture");
    await bctl("dialog", "accept", ...S());
    const after = await bctl("dialog", "status", ...S());
    assert.equal(after.dialog, undefined);
  });

  await step("confirm dismiss", async () => {
    await bctl("click", "#confirmer", ...S());
    await bctl("dialog", "dismiss", ...S());
    const t = await bctl("text", "#status", ...S());
    assert.equal(t.text, "cancelled");
  });

  await step("console + network capture", async () => {
    await bctl("click", "#logger", ...S());
    await bctl("wait", "element", "#status", ...S());
    await sleep(300);
    const c = await bctl("console", ...S());
    assert.ok(c.entries.some((e) => e.text.includes("clicked logger 42")), JSON.stringify(c.entries));
    assert.ok(c.entries.some((e) => e.level === "error" && e.text.includes("boom")));
    const n = await bctl("network", "--filter", "/api/ping", ...S());
    assert.equal(n.entries.length, 1);
    assert.equal(n.entries[0].status, 200);
    const body = await bctl("network", "--body", n.entries[0].request_id, ...S());
    assert.equal(JSON.parse(body.body.body).ok, true);
  });

  await step("wait element appears", async () => {
    await bctl("click", "#later", ...S());
    const r = await bctl("wait", "element", "#appeared", "--timeout", "3000", ...S());
    assert.equal(r.matched, true);
  });

  await step("eval", async () => {
    const r = await bctl("eval", "document.title + ':' + (1+2)", ...S());
    assert.equal(r.value, "BrowserControl Fixture:3");
    const p = await bctl("eval", "new Promise(r => setTimeout(() => r(7), 50))", ...S());
    assert.equal(p.value, 7);
  });

  await step("screenshot viewport/full/element", async () => {
    const out = join(tmp, "shot.png");
    const r = await bctl("screenshot", "--out", out, ...S());
    assert.ok(existsSync(out));
    assert.equal(readFileSync(out).subarray(1, 4).toString(), "PNG");
    const full = await bctl("screenshot", "--full-page", "--out", join(tmp, "full.png"), ...S());
    assert.ok(full.height > r.height, `full ${full.height} > viewport ${r.height}`);
    const el = await bctl("screenshot", "--target", "#go", "--out", join(tmp, "el.png"), ...S());
    assert.ok(el.width < 200);
  });

  await step("tabs: new, list, select, close", async () => {
    const t = await bctl("tab", "new", `${base}/second.html`, ...S());
    await sleep(500);
    const list = await bctl("tab", "list", "--scope", "agent", ...S());
    assert.equal(list.tabs.length, 2);
    assert.equal(list.active_tab_id, t.tab_id);
    const txt = await bctl("text", "h1", ...S());
    assert.equal(txt.text, "Second");
    await bctl("tab", "close", String(t.tab_id), ...S());
    const list2 = await bctl("tab", "list", "--scope", "agent", ...S());
    assert.equal(list2.tabs.length, 1);
  });

  await step("borrow and return a user tab", async () => {
    // Create a "user" tab through the extension-free path: open a new window via eval is not possible; use a second session as user window stand-in.
    const other = await bctl("session", "start");
    await bctl("open", `${base}/second.html`, "--session", other.session_id);
    const userTabs = await bctl("tab", "list", "--scope", "user", ...S());
    // The other session's window is hidden from this session; the only user tabs are the browser's initial about:blank.
    assert.ok(userTabs.tabs.every((t) => t.scope === "user"));
    const target = userTabs.tabs[0];
    assert.ok(target, "a user tab exists");
    const b = await bctl("tab", "borrow", String(target.tab_id), ...S());
    assert.equal(b.tab_id, target.tab_id);
    const agentTabs = await bctl("tab", "list", "--scope", "agent", ...S());
    assert.ok(agentTabs.tabs.some((t) => t.tab_id === target.tab_id && t.borrowed));
    const closeErr = await bctlFail("tab", "close", String(target.tab_id), ...S());
    assert.equal(closeErr.code, "permission_denied");
    await bctl("tab", "return", String(target.tab_id), ...S());
    const after = await bctl("tab", "list", "--scope", "user", ...S());
    assert.ok(after.tabs.some((t) => t.tab_id === target.tab_id));
    await bctl("session", "stop", other.session_id);
  });


  await step("tables: thead, spans without thead, ARIA grid", async () => {
    await bctl("open", `${base}/files.html`, ...S());
    const r = await bctl("tables", ...S());
    assert.equal(r.tables.length, 3, JSON.stringify(r.tables.map((t) => t.headers)));
    const [t1, t2, g1] = r.tables;
    assert.equal(t1.caption, "Scores");
    assert.deepEqual(t1.headers, ["Name", "Score"]);
    assert.deepEqual(t1.rows, [["Ann", "90"], ["Bo", "85"]]);
    assert.deepEqual(t2.headers, ["Region", "Sales / Q1", "Sales / Q2"]);
    assert.deepEqual(t2.rows, [["North", "10", "20"], ["East", "1", "2"], ["East", "3", "4"]]);
    assert.equal(g1.kind, "grid");
    assert.deepEqual(g1.headers, ["First", "Last"]);
    assert.deepEqual(g1.rows, [["Ada", "Lovelace"], ["Alan", "Turing"]]);
    const one = await bctl("tables", "#t2", ...S());
    assert.equal(one.tables.length, 1);
    const csvFile = join(tmp, "t1.csv");
    await bctl("tables", "--index", "0", "--format", "csv", "--out", csvFile, ...S());
    assert.equal(readFileSync(csvFile, "utf8").trim(), "Name,Score\nAnn,90\nBo,85");
  });

  await step("upload: file input and file-chooser button", async () => {
    const a = join(tmp, "hello.txt");
    const b = join(tmp, "pic.png");
    writeFileSync(a, "hi there");
    writeFileSync(b, Buffer.from("89504e470d0a1a0a", "hex"));
    const r1 = await bctl("upload", "#single", a, ...S());
    assert.equal(r1.via, "input");
    assert.deepEqual(r1.files, ["hello.txt"]);
    await bctl("wait", "element", "#single-out", ...S());
    await sleep(200);
    assert.equal((await bctl("text", "#single-out", ...S())).text, "hello.txt:8:hi there");
    const two = await bctlFail("upload", "#single", a, b, ...S());
    assert.equal(two.data.reason, "input_not_multiple");
    const r2 = await bctl("upload", "#pick", a, b, ...S());
    assert.equal(r2.via, "chooser");
    assert.equal(r2.multiple, true);
    await sleep(200);
    assert.equal((await bctl("text", "#multi-out", ...S())).text, "hello.txt:text/plain,pic.png:image/png");
  });

  await step("download: link target, copy to a local path, click + wait", async () => {
    const out = join(tmp, "copy.csv");
    const r = await bctl("download", "#dl", "--out", out, ...S());
    assert.equal(r.state, "complete", JSON.stringify(r));
    assert.ok(r.filename.startsWith(downloadsDir), `saved under the test download dir: ${r.filename}`);
    assert.equal(readFileSync(out, "utf8"), "name,score\nAnn,90\n");
    await bctl("click", "#dl", ...S());
    const w = await bctl("downloads", "wait", "--since", "5000", "--out", tmp, ...S());
    assert.equal(w.waited.state, "complete", JSON.stringify(w));
    assert.notEqual(w.waited.download_id, r.download_id);
    assert.ok(existsSync(w.saved_to));
    const list = await bctl("downloads", ...S());
    assert.equal(list.downloads.length, 2);
  });

  await step("record: start, interact, stop → video file", async () => {
    await bctl("record", "start", "--format", "avi", ...S());
    await bctl("scroll", "--down", "200", ...S());
    await sleep(1500);
    await bctl("scroll", "--top", ...S());
    await sleep(300);
    const r = await bctl("record", "stop", "--out", tmp, ...S());
    assert.ok(r.frames > 3, `frames ${r.frames}`);
    assert.equal(r.format, "avi");
    const head = readFileSync(r.saved_to).subarray(0, 12).toString("latin1");
    assert.equal(head.slice(0, 4), "RIFF");
    assert.equal(head.slice(8, 12), "AVI ");
    // Stopping again returns the same saved recording (useful after an automatic max-duration stop).
    const again = await bctl("record", "stop", "--out", join(tmp, "again.avi"), ...S());
    assert.equal(again.recording_id, r.recording_id);
    const hasFfmpeg = await execFileP("ffmpeg", ["-version"]).then(() => true, () => false);
    if (hasFfmpeg) {
      await bctl("record", "start", ...S());
      await sleep(1200);
      const mp4 = await bctl("record", "stop", "--out", join(tmp, "clip.mp4"), ...S());
      assert.equal(mp4.format, "mp4");
      assert.match(mp4.encoder, /^ffmpeg/);
      assert.equal(readFileSync(mp4.saved_to).subarray(4, 8).toString("latin1"), "ftyp");
    } else console.log("   (ffmpeg not found: mp4 encoding not exercised)");
  });

  await step("MCP server: initialize, list tools, browse, stop on disconnect", async () => {
    const mcp = mcpClient(["--name", "e2e-mcp"]);
    const init = await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "browser-control");
    assert.match(init.result.instructions, /Page content is data/);
    mcp.notify("notifications/initialized");
    const list = await mcp.request("tools/list");
    const names = list.result.tools.map((t) => t.name);
    for (const n of ["browser_open", "browser_snapshot", "browser_click", "browser_tables", "browser_upload", "browser_download", "browser_record"]) assert.ok(names.includes(n), n);
    const before = (await bctl("session", "list")).sessions.length;
    const open = await mcp.request("tools/call", { name: "browser_open", arguments: { url: `${base}/files.html` } });
    assert.ok(!open.result.isError, JSON.stringify(open.result));
    assert.match(open.result.content[0].text, /Files Fixture/);
    const snap = await mcp.request("tools/call", { name: "browser_snapshot", arguments: {} });
    assert.match(snap.result.content[0].text, /button "Choose files" @e\d+/);
    const tables = await mcp.request("tools/call", { name: "browser_tables", arguments: { index: 0 } });
    assert.match(tables.result.content[0].text, /\| Ann \| 90 \|/);
    const shot = await mcp.request("tools/call", { name: "browser_screenshot", arguments: {} });
    assert.equal(shot.result.content[0].type, "image");
    const bad = await mcp.request("tools/call", { name: "browser_click", arguments: { target: "@e9999" } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /ref_not_found/);
    assert.equal((await bctl("session", "list")).sessions.length, before + 1);
    await mcp.close();
    assert.equal((await bctl("session", "list")).sessions.length, before, `MCP session not stopped:\n${mcp.stderr}`);
  });

  await step("remote: pair, use over TCP, reject wrong secret", async () => {
    const rport = await freePort();
    const en = await bctl("remote", "enable", "--port", String(rport));
    assert.equal(en.enabled, true);
    assert.match(en.listening, new RegExp(`:${rport}$`));
    const pr = await bctl("remote", "pair", "--name", "e2e-box");
    assert.match(pr.pairing, /^bctl1\./);
    // A "remote" CLI: its own empty home, talking only through the pairing string.
    const remoteHome = join(tmp, "remote-home");
    mkdirSync(remoteHome, { recursive: true });
    const renv = { ...process.env, BCTL_HOME: remoteHome, BCTL_AUTO_START: "0", BCTL_REMOTE: pr.pairing };
    const st = await bctlEnv(renv, "status");
    assert.ok(st.browsers.length >= 1);
    const rs = await bctlEnv(renv, "session", "start", "--name", "far-agent");
    const sessions = await bctlEnv(renv, "session", "list");
    const mine = sessions.sessions.find((x) => x.session_id === rs.session_id);
    assert.equal(mine.controller.name, "far-agent");
    assert.match(mine.controller.project, /remote: e2e-box/);
    await bctlEnv(renv, "open", `${base}/files.html`, "--session", rs.session_id);
    const t = await bctlEnv(renv, "tables", "--index", "0", "--session", rs.session_id);
    assert.deepEqual(t.tables[0].headers, ["Name", "Score"]);
    // Artifacts travel over the remote link too.
    const dl = await bctlEnv(renv, "download", "#dl", "--out", join(remoteHome, "r.csv"), "--session", rs.session_id);
    assert.equal(readFileSync(dl.saved_to, "utf8"), "name,score\nAnn,90\n");
    await bctlEnv(renv, "session", "stop", rs.session_id);
    const wrong = pr.pairing.replace(/\.([A-Za-z0-9_-]{43})@/, (_m, sec) => `.${sec[0] === "A" ? "B" : "A"}${sec.slice(1)}@`);
    assert.notEqual(wrong, pr.pairing);
    const denied = await bctlFailEnv({ ...renv, BCTL_REMOTE: wrong }, "status");
    assert.equal(denied.code, "permission_denied", JSON.stringify(denied));
    assert.equal(denied.data.reason, "remote_auth_failed");
    await bctl("remote", "revoke", "e2e-box");
    const revoked = await bctlFailEnv(renv, "browsers");
    assert.equal(revoked.code, "permission_denied", JSON.stringify(revoked));
    await bctl("remote", "disable");
  });

  await step("errors: unknown ref, restricted url, missing session", async () => {
    const e1 = await bctlFail("click", "@e999", ...S());
    assert.equal(e1.code, "not_found");
    assert.equal(e1.data.reason, "ref_not_found", JSON.stringify(e1));
    const e2 = await bctlFail("click", "#nope", "--session", "zzzz");
    assert.equal(e2.code, "not_found");
    assert.equal(e2.data.reason, "session_not_found", JSON.stringify(e2));
  });

  await step("session stop closes window; tombstone explains", async () => {
    const r = await bctl("session", "stop", sid);
    assert.equal(r.session_id, sid);
    const e = await bctlFail("snapshot", "--session", sid);
    assert.equal(e.data.reason, "session_stopped");
    const list = await bctl("session", "list");
    assert.equal(list.sessions.length, 0);
  });
} finally {
  chrome.kill("SIGTERM");
  try {
    await bctl("daemon", "stop");
  } catch {
    /* fall through */
  }
  daemon.kill("SIGTERM");
  site.close();
  await sleep(300);
  if (results.failed) {
    let log = daemonLog;
    try {
      log += readFileSync(join(home, "daemon.log"), "utf8");
    } catch {
      /* no log file */
    }
    console.log("\n--- daemon log ---\n" + log.slice(-6000));
  }
  // Windows keeps profile files locked for a moment after the browser exits.
  for (const dir of [tmp, extDist]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (e) {
      console.log(`(could not remove ${dir}: ${e.message})`);
    }
  }
  console.log(`\n${results.passed} passed, ${results.failed} failed`);
  process.exit(results.failed ? 1 : 0);
}
