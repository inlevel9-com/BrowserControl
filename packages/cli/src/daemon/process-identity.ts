// Resolve which browser process owns a loopback TCP connection. The extension cannot name
// Arc or Dia from its user agent, so the daemon asks the OS instead.
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { browserFromProcessName, type ProcessIdentity } from "@browser-control/protocol";

const run = promisify(execFile);

export async function identifyPeer(remotePort: number): Promise<ProcessIdentity | undefined> {
  try {
    if (process.platform === "darwin" || process.platform === "linux") return await viaLsof(remotePort);
    if (process.platform === "win32") return await viaPowershell(remotePort);
  } catch {
    /* best effort */
  }
  return undefined;
}

async function viaLsof(remotePort: number): Promise<ProcessIdentity | undefined> {
  // -F p c n → machine-readable pid / command / name lines. Only the client side has localPort == remotePort.
  const { stdout } = await run("lsof", ["-nP", "-iTCP", "-sTCP:ESTABLISHED", "-Fpcn"], { timeout: 4000 });
  let pid = 0;
  let cmd = "";
  const needle = `:${remotePort}->`;
  for (const line of stdout.split("\n")) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") pid = Number(val);
    else if (tag === "c") cmd = val;
    else if (tag === "n" && val.includes(needle) && pid) {
      return describePid(pid, cmd);
    }
  }
  return undefined;
}

async function describePid(pid: number, cmd: string): Promise<ProcessIdentity> {
  let path = "";
  try {
    const { stdout } = await run("ps", ["-o", "comm=", "-p", String(pid)], { timeout: 2000 });
    path = stdout.trim();
  } catch {
    /* ignore */
  }
  const appMatch = /\/([^/]+)\.app\//.exec(path);
  const name = appMatch?.[1] ?? (path ? basename(path) : cmd) ?? cmd;
  const browser = browserFromProcessName(name) ?? browserFromProcessName(path) ?? browserFromProcessName(cmd);
  return { pid, name, path: path || undefined, ...(browser ? { browser } : {}) };
}

/** PowerShell one-liner that prints `pid|name|path` for the process owning a loopback client port. */
export function powershellPeerScript(remotePort: number): string {
  const port = Math.trunc(remotePort);
  return `$c = Get-NetTCPConnection -LocalPort ${port} -State Established -ErrorAction SilentlyContinue | Where-Object { $_.RemoteAddress -in @('127.0.0.1','::1') } | Select-Object -First 1; if ($c) { $p = Get-Process -Id $c.OwningProcess; Write-Output ("{0}|{1}|{2}" -f $p.Id, $p.ProcessName, $p.Path) }`;
}

/** Parse `pid|name|path` (Windows paths, possibly empty) into a process identity. */
export function parsePowershellPeer(stdout: string): ProcessIdentity | undefined {
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => /^\d+\|/.test(l));
  if (!line) return undefined;
  const [pidS, name = "", ...rest] = line.split("|");
  const path = rest.join("|");
  const pid = Number(pidS);
  if (!Number.isFinite(pid) || pid <= 0) return undefined;
  const exe = path ? path.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") : undefined;
  const browser = browserFromProcessName(name) ?? (exe ? browserFromProcessName(exe) : undefined) ?? browserFromProcessName(path);
  return { pid, name, ...(path ? { path } : {}), ...(browser ? { browser } : {}) };
}

async function viaPowershell(remotePort: number): Promise<ProcessIdentity | undefined> {
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", powershellPeerScript(remotePort)], { timeout: 8000, windowsHide: true });
  return parsePowershellPeer(stdout);
}
