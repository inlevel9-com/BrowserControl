import { createHash } from "node:crypto";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

/** Unix domain socket paths are limited to ~104 bytes on macOS/BSD and 108 on Linux. */
const MAX_SOCK_PATH = 100;

export function bctlHome(): string {
  return process.env.BCTL_HOME && process.env.BCTL_HOME.trim() ? process.env.BCTL_HOME : join(homedir(), ".bctl");
}
export function runDir(): string {
  return join(bctlHome(), "run");
}
export function sockPath(): string {
  if (process.platform === "win32") {
    let user = "user";
    try {
      user = userInfo().username;
    } catch {
      /* ignore */
    }
    const suffix = process.env.BCTL_HOME ? `-${Buffer.from(process.env.BCTL_HOME).toString("hex").slice(0, 16)}` : "";
    return `\\\\.\\pipe\\bctl-${user}${suffix}`;
  }
  const preferred = join(runDir(), "daemon.sock");
  if (Buffer.byteLength(preferred) <= MAX_SOCK_PATH) return preferred;
  const hash = createHash("sha256").update(bctlHome()).digest("hex").slice(0, 12);
  let uid = "u";
  try {
    uid = String(userInfo().uid);
  } catch {
    /* ignore */
  }
  return join(tmpdir(), `bctl-${uid}`, `${hash}.sock`);
}
export function daemonJsonPath(): string {
  return join(bctlHome(), "daemon.json");
}
export function lockPath(): string {
  return join(bctlHome(), "daemon.lock");
}
export function logPath(): string {
  return join(bctlHome(), "daemon.log");
}
export function skillInstallManifest(dir: string): string {
  return join(dir, ".bctl-source.json");
}
