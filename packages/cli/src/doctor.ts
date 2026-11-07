// `bctl doctor`: environment, daemon, browsers, extension, skill.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StatusResult } from "@browser-control/protocol";
import { daemonReachable, once } from "./client";
import { pidAlive, readDaemonInfo } from "./daemon/daemon";
import { bctlHome, logPath, sockPath } from "./paths";
import { harnesses, SKILL_NAME } from "./skill-install";
import { windowsBrowserPaths } from "./win-paths";
import { VERSION } from "./version";

export interface Check {
  name: string;
  ok: boolean | "warn";
  detail: string;
  fix?: string;
}

interface KnownBrowser {
  id: string;
  name: string;
  mac?: string[];
  linux?: string[];
  win?: string[];
  profiles?: string[];
}

const BROWSERS: KnownBrowser[] = [
  { id: "chrome", name: "Google Chrome", mac: ["/Applications/Google Chrome.app"], linux: ["/opt/google/chrome/chrome", "/usr/bin/google-chrome"], profiles: ["Google/Chrome"] },
  { id: "edge", name: "Microsoft Edge", mac: ["/Applications/Microsoft Edge.app"], linux: ["/opt/microsoft/msedge/msedge", "/usr/bin/microsoft-edge"], profiles: ["Microsoft Edge"] },
  { id: "whale", name: "Naver Whale", mac: ["/Applications/Whale.app"], linux: ["/opt/naver/whale/whale", "/usr/bin/naver-whale-stable"], profiles: ["Naver/Whale"] },
  { id: "brave", name: "Brave", mac: ["/Applications/Brave Browser.app"], linux: ["/opt/brave.com/brave/brave", "/usr/bin/brave-browser"], profiles: ["BraveSoftware/Brave-Browser"] },
  { id: "arc", name: "Arc", mac: ["/Applications/Arc.app"], profiles: ["Arc/User Data"] },
  { id: "dia", name: "Dia", mac: ["/Applications/Dia.app"], profiles: ["Dia/User Data"] },
  { id: "vivaldi", name: "Vivaldi", mac: ["/Applications/Vivaldi.app"], linux: ["/opt/vivaldi/vivaldi"], profiles: ["Vivaldi"] },
  { id: "opera", name: "Opera", mac: ["/Applications/Opera.app"], linux: ["/usr/bin/opera"], profiles: ["com.operasoftware.Opera"] },
  { id: "chromium", name: "Chromium", mac: ["/Applications/Chromium.app"], linux: ["/usr/bin/chromium", "/usr/bin/chromium-browser"], profiles: ["Chromium"] },
];

export function installedBrowsers(): Array<{ id: string; name: string; path: string }> {
  const out: Array<{ id: string; name: string; path: string }> = [];
  for (const b of BROWSERS) {
    const paths = process.platform === "darwin" ? b.mac : process.platform === "linux" ? b.linux : windowsBrowserPaths(b.id);
    const hit = (paths ?? []).find((p) => existsSync(p));
    if (hit) out.push({ id: b.id, name: b.name, path: hit });
  }
  return out;
}

export async function runDoctor(): Promise<{ checks: Check[]; status: StatusResult | null }> {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node", ok: major >= 22, detail: `node ${process.versions.node}`, ...(major < 22 ? { fix: "install Node.js 22 or newer" } : {}) });
  checks.push({ name: "cli", ok: true, detail: `bctl ${VERSION} (${process.argv[1]})` });
  checks.push({ name: "home", ok: true, detail: `${bctlHome()} (socket ${sockPath()})` });

  const info = readDaemonInfo();
  const reachable = await daemonReachable();
  let status: StatusResult | null = null;
  if (reachable) {
    status = await once<StatusResult>("system.status", undefined, 3000);
    checks.push({ name: "daemon", ok: true, detail: `running pid ${status.pid}, ws 127.0.0.1:${status.ws_port}, uptime ${status.uptime_secs}s, protocol ${status.protocol_version}` });
  } else if (info && pidAlive(info.pid)) {
    checks.push({ name: "daemon", ok: false, detail: `daemon.json says pid ${info.pid} is alive but the socket does not answer`, fix: `bctl daemon stop && bctl daemon start (log: ${logPath()})` });
  } else {
    checks.push({ name: "daemon", ok: "warn", detail: "not running (commands auto-start it; BCTL_AUTO_START=0 disables that)", fix: "bctl daemon start" });
  }

  const installed = installedBrowsers();
  checks.push({ name: "browsers.installed", ok: installed.length > 0 ? true : "warn", detail: installed.length ? installed.map((b) => b.name).join(", ") : "no known Chromium browser found in the usual locations" });

  if (status) {
    const names = status.browsers.map((b) => `${b.process?.browser ?? b.browser.name}${b.label ? ` "${b.label}"` : ""} (${b.instance_id})`);
    checks.push({
      name: "browsers.connected",
      ok: status.browsers.length > 0 ? true : false,
      detail: names.length ? names.join(", ") : "none",
      ...(names.length ? {} : { fix: "load the BrowserControl extension (chrome://extensions → Load unpacked → packages/extension/dist), open its popup and confirm Connected" }),
    });
    for (const b of status.browsers) {
      if (b.protocol_version !== status.protocol_version) checks.push({ name: `protocol.${b.instance_id}`, ok: "warn", detail: `extension protocol ${b.protocol_version} vs daemon ${status.protocol_version}` });
    }
    checks.push({ name: "sessions", ok: true, detail: status.sessions.length ? status.sessions.map((s) => `${s.session_id}@${s.browser_name}${s.interrupted ? " (interrupted)" : ""}`).join(", ") : "none active" });
  }

  const found = harnesses().filter((h) => existsSync(join(h.dir, "SKILL.md")));
  checks.push({ name: "skill", ok: found.length ? true : "warn", detail: found.length ? found.map((h) => `${h.id}: ${h.dir}`).join("; ") : `${SKILL_NAME} skill not installed in any harness`, ...(found.length ? {} : { fix: "bctl install-skill --harness claude" }) });
  return { checks, status };
}
