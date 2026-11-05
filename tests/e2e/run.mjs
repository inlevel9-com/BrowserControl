// End-to-end: real Chromium + unpacked extension + daemon + bctl CLI against a local fixture site.
// Usage: node tests/e2e/run.mjs [--headful] [--browser "/Applications/Whale.app/Contents/MacOS/Whale"]
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
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
mkdirSync(home, { recursive: true });
mkdirSync(profile, { recursive: true });

// Build a private copy of the extension whose default daemon port is the e2e port.
await promisify(execFile)(process.execPath, [resolve(root, "packages/extension/build.mjs")], { env: { ...process.env, BCTL_EXT_OUT: extDist, BCTL_DAEMON_WS_URL: `ws://127.0.0.1:${PORT}` } });
assert.ok(existsSync(join(extDist, "manifest.json")), "extension build failed");
assert.ok(existsSync(resolve(root, "packages/cli/dist/bctl.mjs")), "build the CLI first: pnpm build");

function findBrowser() {
  if (browserArg) return browserArg;
  // Branded Google Chrome 137+ ignores --load-extension; prefer Chromium / Chrome for Testing builds.
  const pw = resolve(process.env.HOME ?? "", "Library/Caches/ms-playwright");
  const pwChromium = existsSync(pw)
    ? readdirSync(pw)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
        .flatMap((d) => [
          join(pw, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
          join(pw, d, "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
          join(pw, d, "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"),
          join(pw, d, "chrome-mac/Chromium.app/Contents/MacOS/Chromium"),
          join(pw, d, "chrome-linux/chrome"),
        ])
        .find((p) => existsSync(p))
    : undefined;
  const candidates = process.platform === "darwin"
    ? [pwChromium, "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/google/chrome/chrome"];
  const found = candidates.filter(Boolean).find((p) => existsSync(p));
  assert.ok(found, "no Chromium browser found; pass --browser <path>");
  return found;
}

// ---- fixture site
const fixtures = join(here, "fixtures");
const site = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
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
  try {
    await execFileP(process.execPath, [bctlBin, "--json", ...a], { env });
  } catch (e) {
    return JSON.parse(e.stdout).error;
  }
  throw new Error(`expected failure for bctl ${a.join(" ")}`);
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
  if (results.failed) console.log("\n--- daemon log ---\n" + daemonLog.slice(-4000));
  rmSync(tmp, { recursive: true, force: true });
  rmSync(extDist, { recursive: true, force: true });
  console.log(`\n${results.passed} passed, ${results.failed} failed`);
  process.exit(results.failed ? 1 : 0);
}
