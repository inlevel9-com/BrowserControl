// Where Chromium browsers install on Windows (used by `bctl doctor`).

/** Windows install locations, relative to Program Files, Program Files (x86), or Local AppData. */
const WIN: Record<string, string[]> = {
  chrome: ["Google\\Chrome\\Application\\chrome.exe"],
  edge: ["Microsoft\\Edge\\Application\\msedge.exe"],
  whale: ["Naver\\Naver Whale\\Application\\whale.exe"],
  brave: ["BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
  vivaldi: ["Vivaldi\\Application\\vivaldi.exe"],
  opera: ["Programs\\Opera\\opera.exe"],
  chromium: ["Chromium\\Application\\chrome.exe"],
};

export function windowsBrowserPaths(id: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean) as string[];
  return (WIN[id] ?? []).flatMap((rel) => roots.map((r) => `${r.replace(/[\\/]+$/, "")}\\${rel}`));
}
