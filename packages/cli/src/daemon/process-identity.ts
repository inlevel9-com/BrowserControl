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

async function viaPowershell(remotePort: number): Promise<ProcessIdentity | undefined> {
  const script = `$c = Get-NetTCPConnection -LocalPort ${remotePort} -State Established -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-Process -Id $c.OwningProcess; Write-Output ("{0}|{1}|{2}" -f $p.Id, $p.ProcessName, $p.Path) }`;
  const { stdout } = await run("powershell", ["-NoProfile", "-Command", script], { timeout: 6000 });
  const [pidS, name, path] = stdout.trim().split("|");
  if (!pidS) return undefined;
  const browser = browserFromProcessName(name ?? "") ?? browserFromProcessName(path ?? "");
  return { pid: Number(pidS), name: name ?? "", path: path || undefined, ...(browser ? { browser } : {}) };
}
