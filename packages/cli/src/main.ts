// bctl command tree. Human-readable output by default; --json for machines.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, watchFile, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import {
  type ActionResult,
  type ArtifactInfo,
  type BrowserListResult,
  DEFAULT_REMOTE_PORT,
  type DownloadInfo,
  type DownloadResult,
  type DownloadsResult,
  type RecordStartResult,
  type RecordStopResult,
  type RemoteStatusResult,
  type TablesResult,
  type UploadResult,
  type ConsoleResult,
  DEFAULT_WS_PORT,
  type DialogStatusResult,
  type EvaluateResult,
  type FindResult,
  type GetHtmlResult,
  type GetTextResult,
  type NavigateResult,
  type NetworkResult,
  RpcFailure,
  type ScreenshotResult,
  type ScrollResult,
  type SessionEntry,
  type SessionListResult,
  type SessionStartResult,
  type SessionStopResult,
  type SnapshotResult,
  type StatusResult,
  type TabListResult,
  type WaitForElementResult,
  type WaitForNavigationResult,
} from "@browser-control/protocol";
import { daemonReachable, once, rpc, startDaemonDetached } from "./client";
import { describeTable, fetchArtifact, readWireFiles, renderTable, type TableFormat } from "./files";
import { runMcpServer, mcpConfigSnippet } from "./mcp";
import { forgetRemoteClient, formatPairing, newClient, parsePairing, readServerConfig, remoteTarget, saveRemoteClient, writeServerConfig } from "./remote";
import { Daemon, pidAlive, readDaemonInfo } from "./daemon/daemon";
import { runDoctor } from "./doctor";
import { logPath } from "./paths";
import { harnesses, installSkill } from "./skill-install";
import { VERSION } from "./version";

interface Globals {
  session?: string;
  tab?: number;
  json?: boolean;
  quiet?: boolean;
}

const program = new Command();
program
  .name("bctl")
  .description("BrowserControl — drive Chrome, Edge, Whale, Brave, Arc, Dia and other Chromium browsers from any shell-capable AI agent")
  .version(VERSION, "-V, --version")
  .option("-s, --session <id>", "session id (or env BCTL_SESSION; auto-selected when exactly one session exists)")
  .option("-t, --tab <id>", "target tab id (defaults to the session's active tab)", (v) => Number(v))
  .option("--json", "machine-readable JSON output")
  .option("-q, --quiet", "suppress informational output")
  .showHelpAfterError("(run `bctl <command> --help` for usage)")
  .configureHelp({ sortSubcommands: false });

function g(): Globals {
  return program.opts<Globals>();
}

// --------------------------------------------------------------------------- output helpers

function out(value: unknown, human?: () => string): void {
  if (g().json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const s = human ? human() : JSON.stringify(value, null, 2);
  if (s) process.stdout.write(`${s}\n`);
}
function note(msg: string): void {
  if (!g().quiet && !g().json) process.stderr.write(`${msg}\n`);
}
function die(e: unknown): never {
  if (e instanceof RpcFailure) {
    const { code, message, data } = e.error;
    if (g().json) process.stdout.write(`${JSON.stringify({ error: e.error }, null, 2)}\n`);
    else {
      process.stderr.write(`error [${code}${data?.reason ? `/${data.reason}` : ""}]: ${message}\n`);
      if (data?.hint) process.stderr.write(`hint: ${data.hint}\n`);
    }
    process.exit(code === "invalid_params" ? 2 : 1);
  }
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "ECONNREFUSED" || err?.code === "ENOENT") {
    process.stderr.write("error: bctl daemon is not running and auto-start is disabled (BCTL_AUTO_START=0); run `bctl daemon start`\n");
    process.exit(1);
  }
  process.stderr.write(`error: ${err?.message ?? String(e)}\n`);
  process.exit(1);
}

async function run<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    die(e);
  }
}

/** Resolve the session id from --session, BCTL_SESSION, or the single active session. */
async function sessionId(): Promise<string> {
  const explicit = g().session ?? process.env.BCTL_SESSION;
  if (explicit) return explicit;
  const list = await rpc<SessionListResult>("session.list");
  if (list.sessions.length === 1) {
    const id = list.sessions[0]!.session_id;
    note(`(using the only active session ${id}; pass --session to be explicit)`);
    return id;
  }
  if (list.sessions.length === 0) throw new RpcFailure({ code: "not_found", message: "no active session", data: { reason: "session_not_found", hint: "start one with `bctl session start --json` and pass --session <id>" } });
  throw new RpcFailure({ code: "invalid_params", message: `${list.sessions.length} sessions are active; pass --session <id>`, data: { reason: "session_ambiguous", hint: `active: ${list.sessions.map((s) => s.session_id).join(", ")}` } });
}
async function tool<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const session_id = await sessionId();
  const tab = g().tab;
  return rpc<T>(method, { session_id, ...(tab !== undefined ? { tab_id: tab } : {}), ...params });
}
function actionLine(r: ActionResult, verb: string): string {
  let s = `${verb} ${r.target} via ${r.via}`;
  if (r.navigated_to) s += `\n→ navigated to ${r.navigated_to}`;
  if (r.dialog) s += `\n! ${r.dialog.type} dialog opened: ${JSON.stringify(r.dialog.message)} — decide with \`bctl dialog accept|dismiss\``;
  return s;
}
function fmtSession(s: SessionEntry): string {
  return `${s.session_id}  ${s.browser_name.padEnd(9)} window=${s.agent_window_id ?? "?"} tab=${s.active_tab_id ?? "?"}${s.interrupted ? "  INTERRUPTED" : ""}  ${s.controller?.name ? `(${s.controller.name})` : ""}`;
}

// --------------------------------------------------------------------------- daemon / status

const daemon = program.command("daemon").description("manage the local bctl daemon");
daemon
  .command("start")
  .description("start the daemon (detached unless --foreground)")
  .option("--foreground", "run in this process")
  .option("--port <n>", "WebSocket port for extensions", (v) => Number(v), Number(process.env.BCTL_PORT ?? DEFAULT_WS_PORT))
  .action(async (o: { foreground?: boolean; port: number }) => {
    if (o.foreground) {
      const d = new Daemon({ port: o.port, foreground: !process.env.BCTL_DAEMON_CHILD });
      try {
        await d.start();
      } catch (e) {
        process.stderr.write(`error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      return;
    }
    await run(async () => {
      if (await daemonReachable({ local: true })) {
        const info = readDaemonInfo();
        out(info, () => `daemon already running (pid ${info?.pid}, ws port ${info?.ws_port})`);
        return;
      }
      await startDaemonDetached(o.port);
      const info = readDaemonInfo();
      out(info, () => `daemon started (pid ${info?.pid}, ws port ${info?.ws_port}, log ${logPath()})`);
    });
  });
daemon
  .command("stop")
  .description("stop the daemon (ends every session, returns borrowed tabs)")
  .action(async () => {
    const info = readDaemonInfo();
    try {
      await once("system.shutdown", undefined, 5000, { local: true });
    } catch {
      if (info && pidAlive(info.pid)) process.kill(info.pid, "SIGTERM");
      else {
        out({ stopped: false }, () => "daemon is not running");
        return;
      }
    }
    for (let i = 0; i < 40 && info && pidAlive(info.pid); i++) await new Promise((r) => setTimeout(r, 100));
    out({ stopped: true, pid: info?.pid }, () => `daemon stopped${info ? ` (pid ${info.pid})` : ""}`);
  });
daemon
  .command("status")
  .description("alias of `bctl status`")
  .action(() => statusCmd());

async function statusCmd(): Promise<void> {
  await run(async () => {
    const remote = remoteTarget();
    // Remote: report the real failure (auth, refused, timeout) instead of a generic "not running".
    if (!remote && !(await daemonReachable())) {
      out({ running: false }, () => "daemon: not running (any command auto-starts it)");
      return;
    }
    const s = await once<StatusResult>("system.status", undefined, 5000);
    out(s, () => {
      const lines = [`${remote ? `remote daemon at ${remote.host}:${remote.port} — ` : ""}daemon ${s.daemon_version} pid ${s.pid} uptime ${s.uptime_secs}s · ws 127.0.0.1:${s.ws_port} · ${s.sock_path}`];
      lines.push(`browsers (${s.browsers.length}):`);
      for (const b of s.browsers) lines.push(`  ${b.instance_id}  ${(b.process?.browser ?? b.browser.name).padEnd(9)} ${b.label ? `"${b.label}"` : ""}  chromium ${b.browser.version}  ext ${b.extension_version}  sessions ${b.sessions}`);
      lines.push(`sessions (${s.sessions.length}):`);
      for (const x of s.sessions) lines.push(`  ${fmtSession(x)}`);
      return lines.join("\n");
    });
  });
}
program.command("status").description("show daemon, browsers, and sessions").action(statusCmd);

program
  .command("browsers")
  .description("list connected browsers (use the id, label, or name with --browser)")
  .action(async () => {
    await run(async () => {
      const r = await rpc<BrowserListResult>("browser.list");
      out(r, () =>
        r.browsers.length
          ? r.browsers.map((b) => `${b.instance_id}  ${(b.process?.browser ?? b.browser.name).padEnd(9)} ${b.label ? `"${b.label}"` : "(no label)"}  chromium ${b.browser.version}  process=${b.process?.name ?? "?"}  sessions=${b.sessions}`).join("\n")
          : "no browsers connected — load the extension and check its popup shows Connected",
      );
    });
  });

program
  .command("doctor")
  .description("diagnose CLI, daemon, browsers, extension, and skill installation")
  .action(async () => {
    const r = await runDoctor();
    out(r, () =>
      r.checks
        .map((c) => `${c.ok === true ? "✔" : c.ok === "warn" ? "▲" : "✘"} ${c.name.padEnd(20)} ${c.detail}${c.fix ? `\n    fix: ${c.fix}` : ""}`)
        .join("\n"),
    );
    if (r.checks.some((c) => c.ok === false)) process.exitCode = 1;
  });

program
  .command("logs")
  .description("print the daemon log")
  .option("-n, --lines <n>", "last N lines", (v) => Number(v), 80)
  .option("-f, --follow", "follow")
  .action((o: { lines: number; follow?: boolean }) => {
    const p = logPath();
    if (!existsSync(p)) {
      process.stderr.write(`no log at ${p}\n`);
      return;
    }
    const lines = readFileSync(p, "utf8").trimEnd().split("\n");
    process.stdout.write(`${lines.slice(-o.lines).join("\n")}\n`);
    if (o.follow) {
      // Portable `tail -f` (Windows has no tail).
      let pos = statSync(p).size;
      watchFile(p, { interval: 300 }, () => {
        const size = statSync(p).size;
        if (size < pos) pos = 0;
        if (size === pos) return;
        const fd = openSync(p, "r");
        const buf = Buffer.alloc(size - pos);
        readSync(fd, buf, 0, buf.length, pos);
        closeSync(fd);
        pos = size;
        process.stdout.write(buf);
      });
    }
  });

// --------------------------------------------------------------------------- sessions

const session = program.command("session").description("session lifecycle (one Agent Window per session)");
session
  .command("start")
  .description("open a new Agent Window and return its session id")
  .option("-b, --browser <selector>", "instance id, label, or name (chrome|edge|whale|brave|arc|dia); required when >1 browser is connected")
  .option("--focus", "bring the Agent Window to the front (default: background)")
  .option("--width <px>", "window width", (v) => Number(v))
  .option("--height <px>", "window height", (v) => Number(v))
  .option("--incognito", "use the browser's incognito session (extension must be allowed in incognito)")
  .option("--name <controller>", "display name of the controlling agent, shown in the tab overlay")
  .option("--project <name>", "project label shown with the controller name")
  .action(async (o: { browser?: string; focus?: boolean; width?: number; height?: number; incognito?: boolean; name?: string; project?: string }) => {
    await run(async () => {
      const r = await rpc<SessionStartResult>("session.start", {
        browser: o.browser,
        focused: o.focus ?? false,
        width: o.width,
        height: o.height,
        incognito: o.incognito,
        ...(o.name ? { controller: { name: o.name, project: o.project } } : {}),
      });
      out(r, () => `session ${r.session_id} started on ${r.browser.name} (window ${r.agent_window_id}, tab ${r.active_tab_id})\nexport BCTL_SESSION=${r.session_id}`);
    });
  });
session
  .command("stop [id]")
  .description("stop a session: return borrowed tabs and close the Agent Window")
  .option("--all", "stop every session")
  .action(async (id: string | undefined, o: { all?: boolean }) => {
    await run(async () => {
      if (o.all) {
        const r = await rpc<{ stopped: unknown[] }>("session.stop_all");
        out(r, () => `stopped ${r.stopped.length} session(s)`);
        return;
      }
      const sid = id ?? (await sessionId());
      const r = await rpc<SessionStopResult>("session.stop", { session_id: sid });
      out(r, () => `session ${sid} stopped (returned ${r.returned_tabs.length} borrowed tab(s), closed ${r.closed_tabs.length})`);
    });
  });
session
  .command("list")
  .description("list active sessions")
  .action(async () => {
    await run(async () => {
      const r = await rpc<SessionListResult>("session.list");
      out(r, () => (r.sessions.length ? r.sessions.map(fmtSession).join("\n") : "no active sessions"));
    });
  });
session
  .command("resume <id>")
  .description("re-enable actions after the user pressed Stop in the Agent Window")
  .action(async (id: string) => {
    await run(async () => {
      const r = await rpc("session.resume", { session_id: id });
      out(r, () => `session ${id} resumed`);
    });
  });

// --------------------------------------------------------------------------- tabs

const tab = program.command("tab").description("tabs: list, create, select, close, borrow user tabs, return them");
tab
  .command("list")
  .description("list tabs visible to this session")
  .addOption(new Option("--scope <scope>", "user | agent | all").choices(["user", "agent", "all"]).default("all"))
  .action(async (o: { scope: "user" | "agent" | "all" }) => {
    await run(async () => {
      const r = await tool<TabListResult>("tool.tab_list", { scope: o.scope });
      out(r, () => r.tabs.map((t) => `${String(t.tab_id).padStart(6)} ${t.scope.padEnd(5)}${t.borrowed ? "*" : " "}${t.active ? "▶" : " "} ${(t.title ?? "").slice(0, 50).padEnd(50)} ${t.url ?? ""}`).join("\n") || "no tabs");
    });
  });
tab
  .command("new [url]")
  .description("create a tab in the Agent Window")
  .option("--background", "do not make it the active tab")
  .action(async (url: string | undefined, o: { background?: boolean }) => {
    await run(async () => {
      const r = await tool<{ tab_id: number }>("tool.tab_create", { url, active: !o.background });
      out(r, () => `tab ${r.tab_id} created`);
    });
  });
tab
  .command("select <tab-id>")
  .description("make a controlled tab the session's active tab")
  .action(async (id: string) => run(async () => out(await tool("tool.tab_select", { tab_id: Number(id) }), () => `tab ${id} selected`)));
tab
  .command("close <tab-id>")
  .description("close a tab created in the Agent Window")
  .action(async (id: string) => run(async () => out(await tool("tool.tab_close", { tab_id: Number(id) }), () => `tab ${id} closed`)));
tab
  .command("borrow <tab-id>")
  .description("move an existing user tab into the Agent Window (returned on `tab return` or session stop)")
  .action(async (id: string) => {
    await run(async () => {
      const r = await tool<{ tab_id: number; title?: string; url?: string }>("tool.tab_borrow", { tab_id: Number(id) });
      out(r, () => `borrowed tab ${r.tab_id}: ${r.title ?? ""} ${r.url ?? ""}`);
    });
  });
tab
  .command("return <tab-id>")
  .description("return a borrowed tab to its original window")
  .action(async (id: string) => run(async () => out(await tool("tool.tab_return", { tab_id: Number(id) }), () => `tab ${id} returned`)));

program
  .command("window")
  .description("resize the Agent Window")
  .argument("<width>")
  .argument("<height>")
  .action(async (w: string, h: string) => run(async () => out(await tool("tool.window_resize", { width: Number(w), height: Number(h) }), () => `window resized to ${w}x${h}`)));

// --------------------------------------------------------------------------- navigation

function navOut(r: NavigateResult, verb: string): void {
  out(r, () => `${verb} ${r.url}${r.title ? ` — ${r.title}` : ""}${r.status === "timeout" ? " (still loading)" : ""}`);
}
program
  .command("open <url>")
  .alias("navigate")
  .alias("goto")
  .description("navigate the active tab to a URL")
  .addOption(new Option("--wait <until>", "none | load | domcontentloaded").choices(["none", "load", "domcontentloaded"]).default("load"))
  .option("--timeout <ms>", "navigation timeout", (v) => Number(v), 30000)
  .action(async (url: string, o: { wait: "none" | "load" | "domcontentloaded"; timeout: number }) => {
    await run(async () => navOut(await tool<NavigateResult>("tool.navigate", { url, wait_until: o.wait, timeout_ms: o.timeout }), "opened"));
  });
program.command("back").description("history back").action(async () => run(async () => navOut(await tool<NavigateResult>("tool.navigate_back"), "back to")));
program.command("forward").description("history forward").action(async () => run(async () => navOut(await tool<NavigateResult>("tool.navigate_forward"), "forward to")));
program.command("reload").description("reload the active tab").action(async () => run(async () => navOut(await tool<NavigateResult>("tool.reload"), "reloaded")));

// --------------------------------------------------------------------------- reads

program
  .command("snapshot")
  .alias("snap")
  .description("accessibility-style outline of the page with @eN refs for every interactive element")
  .option("--full", "include all visible text, not only interactive elements and headings")
  .option("--root <target>", "limit to a subtree (ref or CSS selector)")
  .option("--max-chars <n>", "truncate output", (v) => Number(v), 40000)
  .action(async (o: { full?: boolean; root?: string; maxChars: number }) => {
    await run(async () => {
      const r = await tool<SnapshotResult>("tool.snapshot", { mode: o.full ? "full" : "interactive", root: o.root, max_chars: o.maxChars });
      out(r, () => {
        let s = `# ${r.title}\n# ${r.url}  (tab ${r.tab_id}, ${r.ref_count} refs, observation ${r.observation_id}${r.truncated ? ", TRUNCATED" : ""})\n${r.text}`;
        if (r.dialog) s += `\n! ${r.dialog.type} dialog open: ${JSON.stringify(r.dialog.message)}`;
        return s;
      });
    });
  });
program
  .command("find <query>")
  .description("find interactive elements whose role/name contains the query")
  .option("--limit <n>", "max matches", (v) => Number(v), 20)
  .action(async (query: string, o: { limit: number }) => {
    await run(async () => {
      const r = await tool<FindResult>("tool.find", { query, limit: o.limit });
      out(r, () => (r.matches.length ? r.matches.map((m) => `@${m.ref}  ${m.role} ${JSON.stringify(m.name)}`).join("\n") : "no matches"));
    });
  });
program
  .command("text [target]")
  .description("visible text of the page or of one element")
  .option("--max-chars <n>", "truncate", (v) => Number(v), 100000)
  .action(async (target: string | undefined, o: { maxChars: number }) => {
    await run(async () => {
      const r = await tool<GetTextResult>("tool.get_text", { target, max_chars: o.maxChars });
      out(r, () => `${r.text}${r.truncated ? "\n[truncated]" : ""}`);
    });
  });
program
  .command("html [target]")
  .description("HTML of the document or of one element")
  .option("--inner", "innerHTML instead of outerHTML")
  .option("--max-chars <n>", "truncate", (v) => Number(v), 200000)
  .action(async (target: string | undefined, o: { inner?: boolean; maxChars: number }) => {
    await run(async () => {
      const r = await tool<GetHtmlResult>("tool.get_html", { target, outer: !o.inner, max_chars: o.maxChars });
      out(r, () => `${r.html}${r.truncated ? "\n<!-- truncated -->" : ""}`);
    });
  });
program
  .command("screenshot")
  .description("capture the viewport, the full page, or one element as PNG/JPEG")
  .option("-o, --out <file>", "output file (default: screenshot-<tab>-<time>.png)")
  .option("--full-page", "capture the whole scrollable page")
  .option("--target <target>", "clip to a ref or CSS selector")
  .option("--jpeg", "JPEG instead of PNG")
  .option("--quality <n>", "JPEG quality", (v) => Number(v), 80)
  .action(async (o: { out?: string; fullPage?: boolean; target?: string; jpeg?: boolean; quality: number }) => {
    await run(async () => {
      const r = await tool<ScreenshotResult>("tool.screenshot", { full_page: o.fullPage, target: o.target, format: o.jpeg ? "jpeg" : "png", quality: o.quality });
      const file = resolve(o.out ?? `screenshot-${r.tab_id}-${Date.now()}.${r.format}`);
      writeFileSync(file, Buffer.from(r.data, "base64"));
      const { data: _d, ...meta } = r;
      out({ ...meta, file }, () => `saved ${file} (${r.width}x${r.height}, via ${r.via})`);
    });
  });
program
  .command("pdf")
  .description("print the page to PDF")
  .requiredOption("-o, --out <file>", "output file")
  .option("--landscape")
  .action(async (o: { out: string; landscape?: boolean }) => {
    await run(async () => {
      const r = await tool<{ tab_id: number; data: string }>("tool.pdf", { landscape: o.landscape });
      const file = resolve(o.out);
      writeFileSync(file, Buffer.from(r.data, "base64"));
      out({ tab_id: r.tab_id, file }, () => `saved ${file}`);
    });
  });

// --------------------------------------------------------------------------- input

program
  .command("click <target>")
  .description("click a ref (@e12) or CSS selector with trusted input")
  .option("--right", "right button")
  .option("--middle", "middle button")
  .option("--double", "double click")
  .option("--mod <keys>", "modifiers, comma separated: ctrl,shift,alt,meta")
  .option("--dom", "dispatch DOM events only (no debugger)")
  .action(async (target: string, o: { right?: boolean; middle?: boolean; double?: boolean; mod?: string; dom?: boolean }) => {
    await run(async () => {
      const r = await tool<ActionResult>("tool.click", {
        target,
        button: o.right ? "right" : o.middle ? "middle" : "left",
        click_count: o.double ? 2 : 1,
        modifiers: o.mod ? o.mod.split(",").map((s) => s.trim()) : undefined,
        dom: o.dom,
      });
      out(r, () => actionLine(r, "clicked"));
    });
  });
program
  .command("hover <target>")
  .description("move the mouse over an element (reveals hover menus)")
  .action(async (target: string) => run(async () => out(await tool<ActionResult>("tool.hover", { target }), () => `hovered ${target}`)));
program
  .command("fill <target> <value>")
  .description("replace the value of an input, textarea, or contenteditable")
  .option("--submit", "press Enter afterwards")
  .action(async (target: string, value: string, o: { submit?: boolean }) => {
    await run(async () => {
      const r = await tool<ActionResult>("tool.fill", { target, value, submit: o.submit });
      out(r, () => actionLine(r, "filled"));
    });
  });
program
  .command("type <text>")
  .description("type text into the focused element")
  .option("--delay <ms>", "per-character delay", (v) => Number(v))
  .action(async (text: string, o: { delay?: number }) => run(async () => out(await tool<ActionResult>("tool.type", { text, delay_ms: o.delay }), () => `typed ${text.length} chars`)));
program
  .command("press <key>")
  .description("press a key or combo: Enter, Tab, Escape, ArrowDown, Control+a, cmd+k")
  .option("--target <target>", "focus this element first")
  .action(async (key: string, o: { target?: string }) => {
    await run(async () => {
      const r = await tool<ActionResult>("tool.press", { key, target: o.target });
      out(r, () => actionLine(r, `pressed ${key} on`));
    });
  });
program
  .command("select <target> <values...>")
  .description("choose <select> options by value or exact label")
  .action(async (target: string, values: string[]) => {
    await run(async () => {
      const r = await tool<ActionResult & { selected: string[] }>("tool.select", { target, values });
      out(r, () => `selected [${r.selected.join(", ")}] in ${target}`);
    });
  });
program.command("check <target>").description("check a checkbox/radio/switch").action(async (target: string) => run(async () => out(await tool("tool.check", { target, checked: true }), () => `checked ${target}`)));
program.command("uncheck <target>").description("uncheck a checkbox/switch").action(async (target: string) => run(async () => out(await tool("tool.check", { target, checked: false }), () => `unchecked ${target}`)));
program
  .command("scroll")
  .description("scroll the page or a scrollable element")
  .option("--down <px>", "scroll down", (v) => Number(v))
  .option("--up <px>", "scroll up", (v) => Number(v))
  .option("--top", "to the top")
  .option("--bottom", "to the bottom")
  .option("--target <target>", "scroll inside this element")
  .action(async (o: { down?: number; up?: number; top?: boolean; bottom?: boolean; target?: string }) => {
    await run(async () => {
      const dy = (o.down ?? 0) - (o.up ?? 0);
      const r = await tool<ScrollResult>("tool.scroll", { target: o.target, delta_y: dy || (o.top || o.bottom ? 0 : 600), to: o.top ? "top" : o.bottom ? "bottom" : undefined });
      out(r, () => `scrolled to (${r.scroll_x}, ${r.scroll_y})${r.at_bottom ? " — at bottom" : ""}`);
    });
  });
program.command("scroll-to <target>").description("scroll an element into view").action(async (target: string) => run(async () => out(await tool("tool.scroll_to", { target }), () => `scrolled to ${target}`)));

// --------------------------------------------------------------------------- script / debugging

program
  .command("eval <expression>")
  .alias("evaluate")
  .description("evaluate a JavaScript expression in the page (promises are awaited)")
  .option("--isolated", "run in the extension's isolated world")
  .option("--timeout <ms>", "", (v) => Number(v), 15000)
  .action(async (expression: string, o: { isolated?: boolean; timeout: number }) => {
    await run(async () => {
      const r = await tool<EvaluateResult>("tool.evaluate", { expression, world: o.isolated ? "isolated" : "main", timeout_ms: o.timeout });
      out(r, () => (typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2)));
    });
  });
program
  .command("console")
  .description("console messages and exceptions captured since the tab was first attached")
  .option("--since <seq>", "entries after this sequence number", (v) => Number(v))
  .option("--level <level>", "filter: log | warning | error | …")
  .option("--limit <n>", "", (v) => Number(v), 200)
  .option("--clear", "clear the buffer after reading")
  .action(async (o: { since?: number; level?: string; limit: number; clear?: boolean }) => {
    await run(async () => {
      const r = await tool<ConsoleResult>("tool.console", { since_seq: o.since, level: o.level, limit: o.limit, clear: o.clear });
      out(r, () => (r.entries.length ? r.entries.map((e) => `#${e.seq} ${e.level.padEnd(8)} ${e.text}${e.url ? `  (${e.url}:${e.line ?? ""})` : ""}`).join("\n") : `no entries${r.capturing ? "" : " (capture unavailable: debugger could not attach)"}`));
    });
  });
program
  .command("network")
  .description("network requests captured since the tab was first attached")
  .option("--since <seq>", "", (v) => Number(v))
  .option("--filter <text>", "URL substring or HTTP method")
  .option("--limit <n>", "", (v) => Number(v), 200)
  .option("--clear")
  .option("--body <request-id>", "fetch one response body")
  .action(async (o: { since?: number; filter?: string; limit: number; clear?: boolean; body?: string }) => {
    await run(async () => {
      const r = await tool<NetworkResult>("tool.network", { since_seq: o.since, filter: o.filter, limit: o.limit, clear: o.clear, body_for: o.body });
      out(r, () => {
        if (r.body) return r.body.base64 ? `[base64 body, ${r.body.body.length} chars]` : r.body.body;
        return r.entries.length
          ? r.entries.map((e) => `#${e.seq} ${e.request_id.padEnd(10)} ${String(e.status ?? (e.failed ? "FAIL" : "…")).padEnd(4)} ${e.method.padEnd(6)} ${e.url}${e.duration_ms !== undefined ? `  ${e.duration_ms}ms` : ""}${e.failed ? `  ${e.failed}` : ""}`).join("\n")
          : `no entries${r.capturing ? "" : " (capture unavailable)"}`;
      });
    });
  });

// --------------------------------------------------------------------------- waits

const wait = program.command("wait").description("wait for an element, a navigation, or a duration");
wait
  .command("element <target>")
  .addOption(new Option("--state <state>", "visible | hidden | attached | detached").choices(["visible", "hidden", "attached", "detached"]).default("visible"))
  .option("--timeout <ms>", "", (v) => Number(v), 10000)
  .action(async (target: string, o: { state: string; timeout: number }) => {
    await run(async () => {
      const r = await tool<WaitForElementResult>("tool.wait_for_element", { target, state: o.state, timeout_ms: o.timeout });
      out(r, () => (r.matched ? `${target} is ${o.state} after ${r.elapsed_ms}ms` : `timeout: ${target} not ${o.state} after ${r.elapsed_ms}ms`));
      if (!r.matched) process.exitCode = 1;
    });
  });
wait
  .command("nav")
  .alias("navigation")
  .option("--url <substring>", "wait until the URL contains this")
  .option("--timeout <ms>", "", (v) => Number(v), 15000)
  .action(async (o: { url?: string; timeout: number }) => {
    await run(async () => {
      const r = await tool<WaitForNavigationResult>("tool.wait_for_navigation", { url_includes: o.url, timeout_ms: o.timeout });
      out(r, () => `${r.reached}: ${r.url}`);
      if (r.reached === "timeout") process.exitCode = 1;
    });
  });
wait
  .command("ms <milliseconds>")
  .action(async (ms: string) => run(async () => out(await rpc("tool.wait_ms", { ms: Number(ms) }), () => `waited ${ms}ms`)));

// --------------------------------------------------------------------------- dialogs / cookies

const dialog = program.command("dialog").description("native alert/confirm/prompt/beforeunload dialogs");
dialog.command("status").action(async () =>
  run(async () => {
    const r = await tool<DialogStatusResult>("tool.dialog_status");
    out(r, () => (r.dialog ? `${r.dialog.type}: ${JSON.stringify(r.dialog.message)}${r.dialog.default_prompt ? ` (default ${JSON.stringify(r.dialog.default_prompt)})` : ""}` : "no dialog open"));
  }),
);
dialog
  .command("accept")
  .option("--text <text>", "prompt answer")
  .action(async (o: { text?: string }) => run(async () => out(await tool("tool.dialog_handle", { accept: true, text: o.text }), () => "accepted")));
dialog.command("dismiss").action(async () => run(async () => out(await tool("tool.dialog_handle", { accept: false }), () => "dismissed")));

program
  .command("cookies")
  .description("list cookie names for the current site (values are never returned)")
  .option("--domain <domain>")
  .action(async (o: { domain?: string }) => {
    await run(async () => {
      const r = await tool<{ cookies: Array<{ name: string; domain: string; secure: boolean; http_only: boolean }> }>("tool.cookies", { domain: o.domain });
      out(r, () => r.cookies.map((c) => `${c.name.padEnd(32)} ${c.domain}${c.secure ? " secure" : ""}${c.http_only ? " httponly" : ""}`).join("\n") || "no cookies");
    });
  });

// --------------------------------------------------------------------------- files

program
  .command("upload <target> <files...>")
  .description("put local files into a file input (<input type=file>), or into the file picker a button opens")
  .action(async (target: string, files: string[]) => {
    await run(async () => {
      const r = await tool<UploadResult>("tool.upload", { target, files: readWireFiles(files) });
      out(r, () => `uploaded ${r.files.join(", ")} to ${target} via ${r.via === "input" ? "the file input" : "the file chooser"}`);
    });
  });

function fmtDownload(d: DownloadInfo): string {
  const size = d.total_bytes > 0 ? `${Math.round(d.total_bytes / 1024)} KiB` : `${Math.round(d.bytes_received / 1024)} KiB`;
  return `#${d.download_id}  ${d.state.padEnd(11)} ${size.padStart(9)}  ${d.basename || "(pending name)"}${d.error ? `  error=${d.error}` : ""}\n      ${d.url.slice(0, 120)}`;
}
async function saveDownload(d: DownloadInfo, outPath: string): Promise<string> {
  const a = await rpc<ArtifactInfo>("download.fetch", { session_id: await sessionId(), download_id: d.download_id });
  return fetchArtifact(a, outPath);
}

program
  .command("download <url-or-target>")
  .description("download a URL or a link (@ref/selector) with the browser's cookies and wait for it")
  .option("-o, --out <path>", "also copy the file here (file or directory; works for remote daemons)")
  .option("--filename <name>", "name inside the browser's download folder")
  .option("--timeout <ms>", "wait at most this long", (v) => Number(v), 120000)
  .option("--no-wait", "return as soon as the download starts")
  .action(async (what: string, o: { out?: string; filename?: string; timeout: number; wait: boolean }) => {
    await run(async () => {
      const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(what) || what.startsWith("/") || what.startsWith("./") || what.startsWith("../");
      const r = await tool<DownloadResult>("tool.download", { ...(isUrl ? { url: what } : { target: what }), filename: o.filename });
      let d = r.download;
      if (o.wait) {
        const w = await rpc<DownloadsResult>("tool.downloads", { session_id: await sessionId(), download_id: d.download_id, wait: true, timeout_ms: o.timeout }, { timeoutMs: o.timeout + 15_000 });
        d = w.waited ?? d;
        if (w.timed_out) process.exitCode = 1;
      }
      const saved = o.out && d.state === "complete" ? await saveDownload(d, o.out) : undefined;
      out({ ...d, ...(saved ? { saved_to: saved } : {}) }, () => `${fmtDownload(d)}${d.filename ? `\n      → ${d.filename}` : ""}${saved ? `\n      copied to ${saved}` : ""}`);
      if (d.state === "interrupted") process.exitCode = 1;
    });
  });

const downloads = program.command("downloads").description("downloads started by this session (clicks on download links, `bctl download`)");
downloads
  .command("list", { isDefault: true })
  .description("list this session's downloads")
  .action(async () => {
    await run(async () => {
      const r = await rpc<DownloadsResult>("tool.downloads", { session_id: await sessionId() });
      out(r, () => (r.downloads.length ? r.downloads.map(fmtDownload).join("\n") : "no downloads in this session"));
    });
  });
downloads
  .command("wait")
  .description("wait for a download to finish: the given id, or the newest one (waiting for a click to start one)")
  .option("--id <n>", "download id", (v) => Number(v))
  .option("--since <ms>", "only downloads started within the last N ms (default 30000)", (v) => Number(v), 30000)
  .option("--timeout <ms>", "", (v) => Number(v), 60000)
  .option("-o, --out <path>", "copy the finished file here (file or directory)")
  .action(async (o: { id?: number; since: number; timeout: number; out?: string }) => {
    await run(async () => {
      const r = await rpc<DownloadsResult>("tool.downloads", { session_id: await sessionId(), download_id: o.id, wait: true, since_ms: Date.now() - o.since, timeout_ms: o.timeout }, { timeoutMs: o.timeout + 15_000 });
      const d = r.waited;
      const saved = o.out && d?.state === "complete" ? await saveDownload(d, o.out) : undefined;
      out({ ...r, ...(saved ? { saved_to: saved } : {}) }, () => {
        if (!d) return "timeout: no download started";
        return `${r.timed_out ? "timeout: still " : ""}${fmtDownload(d)}${d.filename ? `\n      → ${d.filename}` : ""}${saved ? `\n      copied to ${saved}` : ""}`;
      });
      if (r.timed_out || !d || d.state !== "complete") process.exitCode = 1;
    });
  });
downloads
  .command("get <id>")
  .description("copy a finished download to a local path (works for remote daemons)")
  .requiredOption("-o, --out <path>", "file or directory")
  .action(async (id: string, o: { out: string }) => {
    await run(async () => {
      const a = await rpc<ArtifactInfo>("download.fetch", { session_id: await sessionId(), download_id: Number(id) });
      const file = await fetchArtifact(a, o.out);
      out({ ...a, saved_to: file }, () => `saved ${file} (${a.size} bytes)`);
    });
  });

// --------------------------------------------------------------------------- tables

program
  .command("tables [target]")
  .alias("table")
  .description("extract tables (<table>, ARIA grid/table) as rows and columns")
  .option("--index <n>", "only this table", (v) => Number(v))
  .addOption(new Option("--format <fmt>", "md | csv | tsv | json").choices(["md", "csv", "tsv", "json"]).default("md"))
  .option("--max-rows <n>", "rows per table", (v) => Number(v), 500)
  .option("-o, --out <file>", "write the rendered table(s) to a file")
  .action(async (target: string | undefined, o: { index?: number; format: TableFormat; maxRows: number; out?: string }) => {
    await run(async () => {
      const r = await tool<TablesResult>("tool.tables", { target, max_rows: o.maxRows });
      const tables = o.index !== undefined ? r.tables.filter((t) => t.index === o.index) : r.tables;
      if (o.index !== undefined && tables.length === 0) throw new RpcFailure({ code: "not_found", message: `no table ${o.index}; found ${r.tables.length}`, data: { reason: "table_not_found" } });
      const rendered = tables.map((t) => (tables.length > 1 || o.format === "md" ? `## ${describeTable(t)}\n\n` : "") + renderTable(t, o.format)).join("\n\n");
      if (o.out) {
        writeFileSync(resolve(o.out), `${rendered}\n`);
        out({ ...r, tables, file: resolve(o.out) }, () => `wrote ${tables.length} table(s) to ${resolve(o.out!)}`);
        return;
      }
      out({ ...r, tables }, () => (tables.length ? rendered : "no tables found"));
    });
  });

// --------------------------------------------------------------------------- recording

const record = program.command("record").description("record the session's tab as a video");
record
  .command("start")
  .description("start recording the active tab (stop with `bctl record stop --out video.mp4`)")
  .addOption(new Option("--format <fmt>", "mp4 | webm (need ffmpeg) | avi (built in)").choices(["mp4", "webm", "avi"]).default("mp4"))
  .option("--max-secs <n>", "stop automatically after N seconds", (v) => Number(v), 300)
  .option("--quality <n>", "JPEG quality of captured frames", (v) => Number(v), 70)
  .option("--max-width <px>", "", (v) => Number(v), 1280)
  .option("--max-height <px>", "", (v) => Number(v), 800)
  .action(async (o: { format: string; maxSecs: number; quality: number; maxWidth: number; maxHeight: number }) => {
    await run(async () => {
      const r = await tool<RecordStartResult>("record.start", { format: o.format, max_secs: o.maxSecs, quality: o.quality, max_width: o.maxWidth, max_height: o.maxHeight });
      out(r, () => `recording ${r.recording_id} on tab ${r.tab_id} (stops by itself after ${r.max_secs}s)`);
    });
  });
record
  .command("stop")
  .description("stop recording and save the video")
  .option("-o, --out <path>", "where to save the video (file or directory; default: current directory)")
  .addOption(new Option("--format <fmt>", "override the format chosen at start").choices(["mp4", "webm", "avi"]))
  .action(async (o: { out?: string; format?: string }) => {
    await run(async () => {
      const r = await rpc<RecordStopResult>("record.stop", { session_id: await sessionId(), ...(o.format ? { format: o.format } : {}) }, { timeoutMs: 600_000 });
      const file = await fetchArtifact(r.artifact, o.out ?? ".");
      out({ ...r, saved_to: file }, () => `saved ${file} (${(r.duration_ms / 1000).toFixed(1)}s, ${r.frames} frames, ${r.encoder}${r.reason !== "stopped" ? `, ended: ${r.reason}` : ""})`);
    });
  });

// --------------------------------------------------------------------------- remote

const remote = program.command("remote").description("let a bctl on another machine use this machine's browsers (or point this bctl at one)");
function remoteSummary(st: RemoteStatusResult & { error?: string }): string {
  const lines = [`remote access: ${st.enabled ? `enabled${st.listening ? `, listening on ${st.listening}` : ", not listening (daemon not running?)"}` : "disabled"}${st.error ? ` — ${st.error}` : ""}`];
  lines.push(`paired clients (${st.clients.length}):`);
  for (const c of st.clients) lines.push(`  ${c.name.padEnd(20)} ${c.client_id}  paired ${c.created_at.slice(0, 10)}${c.last_used_at ? `  last used ${c.last_used_at.replace("T", " ").slice(0, 16)}` : ""}`);
  const client = remoteTarget();
  if (client) lines.push(`this machine's bctl uses the remote daemon at ${client.host}:${client.port}`);
  return lines.join("\n");
}
async function reloadRemote(): Promise<(RemoteStatusResult & { error?: string }) | null> {
  if (!(await daemonReachable({ local: true }))) return null;
  return once<RemoteStatusResult & { error?: string }>("remote.reload", undefined, 5000, { local: true });
}
function localRemoteStatus(): RemoteStatusResult {
  const c = readServerConfig();
  return { enabled: c.enabled, clients: c.clients.map((x) => ({ client_id: x.client_id, name: x.name, created_at: x.created_at, ...(x.last_used_at ? { last_used_at: x.last_used_at } : {}) })) };
}
remote
  .command("enable")
  .description("accept remote bctl clients on this machine (the browser's machine)")
  .option("--host <addr>", "address to listen on; keep 127.0.0.1 and use an SSH tunnel, or use a private address such as a Tailscale IP", "127.0.0.1")
  .option("--port <n>", "TCP port", (v) => Number(v), DEFAULT_REMOTE_PORT)
  .action(async (o: { host: string; port: number }) => {
    await run(async () => {
      const c = readServerConfig();
      writeServerConfig({ ...c, enabled: true, host: o.host, port: o.port });
      if (!(await daemonReachable({ local: true }))) await startDaemonDetached();
      const st = (await reloadRemote()) ?? localRemoteStatus();
      if (!/^(127\.|::1$|localhost$)/.test(o.host)) note(`warning: listening on ${o.host}. Anyone who can reach this port still needs a pairing secret, but prefer a private network (Tailscale, VPN) or an SSH tunnel.`);
      out(st, () => `${remoteSummary(st)}\nnext: \`bctl remote pair --name <machine>\` and run the printed command on the other machine`);
    });
  });
remote
  .command("disable")
  .description("stop accepting remote clients (pairings are kept)")
  .action(async () => {
    await run(async () => {
      writeServerConfig({ ...readServerConfig(), enabled: false });
      const st = (await reloadRemote()) ?? localRemoteStatus();
      out(st, () => remoteSummary(st));
    });
  });
remote
  .command("pair")
  .description("create a pairing for another machine and print the command to run there")
  .requiredOption("--name <name>", "a name for the other machine, e.g. devbox")
  .option("--connect-host <host>", "host the other machine should dial (default: the listen address)")
  .action(async (o: { name: string; connectHost?: string }) => {
    await run(async () => {
      const c = readServerConfig();
      if (c.clients.some((x) => x.name === o.name)) throw new RpcFailure({ code: "invalid_params", message: `a pairing named "${o.name}" exists; revoke it first or choose another name`, data: { reason: "name_taken" } });
      const client = newClient(o.name);
      c.clients.push(client);
      if (!c.enabled) {
        c.enabled = true;
        note(`remote access was disabled; enabling it on ${c.host}:${c.port}`);
      }
      writeServerConfig(c);
      if (!(await daemonReachable({ local: true }))) await startDaemonDetached();
      await reloadRemote();
      const host = o.connectHost ?? (c.host === "0.0.0.0" || c.host === "::" ? "<this machine's address>" : c.host);
      const pairing = formatPairing({ clientId: client.client_id, secret: Buffer.from(client.secret, "base64url"), host, port: c.port });
      out({ name: o.name, client_id: client.client_id, pairing }, () =>
        [
          `paired "${o.name}". On that machine run (this secret is shown only once):`,
          "",
          `  bctl remote use '${pairing}'`,
          "",
          ...(/^(127\.|::1$|localhost$)/.test(host) ? [`Port ${c.port} only listens on loopback here. Open a tunnel from this machine first, e.g.:`, `  ssh -N -R ${c.port}:127.0.0.1:${c.port} <user>@<other machine>`, ""] : []),
          `Revoke later with: bctl remote revoke ${o.name}`,
        ].join("\n"),
      );
    });
  });
remote
  .command("revoke <name-or-id>")
  .description("remove a pairing; that machine can no longer connect")
  .action(async (who: string) => {
    await run(async () => {
      const c = readServerConfig();
      const before = c.clients.length;
      c.clients = c.clients.filter((x) => x.name !== who && x.client_id !== who);
      if (c.clients.length === before) throw new RpcFailure({ code: "not_found", message: `no pairing named ${who}`, data: { reason: "pairing_not_found" } });
      writeServerConfig(c);
      const st = (await reloadRemote()) ?? localRemoteStatus();
      out(st, () => `revoked ${who}\n${remoteSummary(st)}`);
    });
  });
remote
  .command("status")
  .alias("list")
  .description("show remote access settings and pairings")
  .action(async () => {
    await run(async () => {
      const st = (await daemonReachable({ local: true })) ? await once<RemoteStatusResult & { error?: string }>("remote.status", undefined, 5000, { local: true }) : localRemoteStatus();
      out(st, () => remoteSummary(st));
    });
  });
remote
  .command("use <pairing>")
  .description("on the other machine: send every bctl command to the paired daemon")
  .action(async (pairing: string) => {
    await run(async () => {
      const p = parsePairing(pairing);
      saveRemoteClient(pairing);
      let ok = false;
      try {
        await once("system.ping", undefined, 5000);
        ok = true;
      } catch (e) {
        note(`saved, but the daemon at ${p.host}:${p.port} did not answer yet: ${(e as Error).message}`);
      }
      out({ host: p.host, port: p.port, reachable: ok }, () => `bctl now uses the daemon at ${p.host}:${p.port}${ok ? " (reachable)" : ""}. Undo with \`bctl remote forget\`; BCTL_REMOTE=off skips it for one command.`);
    });
  });
remote
  .command("forget")
  .description("on the other machine: go back to the local daemon")
  .action(() => {
    const removed = forgetRemoteClient();
    out({ removed }, () => (removed ? "bctl uses the local daemon again" : "no remote daemon was configured"));
  });

// --------------------------------------------------------------------------- MCP

program
  .command("mcp")
  .description("run as an MCP server over stdio (for Claude Desktop, Claude Code, Codex, Cursor, …)")
  .option("-b, --browser <selector>", "browser for the session the server starts (id, label, or name)")
  .option("--name <controller>", "agent name shown in the tab overlay", "MCP agent")
  .option("--focus", "bring the Agent Window to the front")
  .option("--keep-session", "leave the session open when the client disconnects")
  .addOption(new Option("--print-config <client>", "print a config snippet instead of serving").choices(["claude-desktop", "claude-code", "codex", "cursor", "json"]))
  .action(async (o: { browser?: string; name: string; focus?: boolean; keepSession?: boolean; printConfig?: string }) => {
    if (o.printConfig) {
      process.stdout.write(`${mcpConfigSnippet(o.printConfig)}\n`);
      return;
    }
    await runMcpServer({ browser: o.browser, controller: o.name, focus: !!o.focus, keepSession: !!o.keepSession });
  });

// --------------------------------------------------------------------------- skill

program
  .command("install-skill")
  .description("install the browser-control skill into agent harnesses")
  .option("--harness <ids>", "comma-separated: claude,claude-project,codex,cursor,gemini,windsurf,copilot,agents,all", "claude")
  .option("--dir <path>", "install into an explicit directory instead")
  .option("--list", "show targets and exit")
  .option("--force", "replace existing or edited installations")
  .action((o: { harness: string; dir?: string; list?: boolean; force?: boolean }) => {
    const all = harnesses();
    if (o.list) {
      out(all, () => all.map((h) => `${h.id.padEnd(15)} ${h.label.padEnd(26)} ${h.dir}${existsSync(h.dir) ? "  (installed)" : ""}`).join("\n"));
      return;
    }
    const targets = o.dir ? [{ id: "custom", label: "custom", dir: resolve(o.dir) }] : o.harness === "all" ? all.filter((h) => h.id !== "claude-project") : all.filter((h) => o.harness.split(",").map((s) => s.trim()).includes(h.id));
    if (!targets.length) {
      process.stderr.write(`unknown harness "${o.harness}"; see --list\n`);
      process.exit(2);
    }
    const results = targets.map((h) => installSkill(h, { force: o.force }));
    out(results, () =>
      results
        .map((r) => {
          const msg: Record<string, string> = {
            installed: "installed",
            updated: "updated",
            unchanged: "already up to date",
            skipped_exists: "skipped: directory exists and was not installed by bctl (use --force)",
            skipped_modified: "skipped: local edits detected (use --force to replace)",
          };
          return `${r.harness.id.padEnd(15)} ${msg[r.status]} → ${r.harness.dir}`;
        })
        .join("\n"),
    );
  });

program.parseAsync(process.argv).catch(die);
