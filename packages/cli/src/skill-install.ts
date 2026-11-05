// Installs the browser-control skill into agent harness skill directories.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { skillInstallManifest } from "./paths";
import { VERSION } from "./version";

export const SKILL_NAME = "browser-control";

export interface Harness {
  id: string;
  label: string;
  dir: string;
}

export function harnesses(): Harness[] {
  const h = homedir();
  const cwd = process.cwd();
  return [
    { id: "claude", label: "Claude Code (user)", dir: join(h, ".claude", "skills", SKILL_NAME) },
    { id: "claude-project", label: "Claude Code (this project)", dir: join(cwd, ".claude", "skills", SKILL_NAME) },
    { id: "codex", label: "Codex CLI", dir: join(h, ".codex", "skills", SKILL_NAME) },
    { id: "cursor", label: "Cursor", dir: join(h, ".cursor", "skills", SKILL_NAME) },
    { id: "gemini", label: "Gemini CLI", dir: join(h, ".gemini", "skills", SKILL_NAME) },
    { id: "windsurf", label: "Windsurf", dir: join(h, ".codeium", "windsurf", "skills", SKILL_NAME) },
    { id: "copilot", label: "GitHub Copilot CLI", dir: join(h, ".copilot", "skills", SKILL_NAME) },
    { id: "agents", label: "Generic (.agents/skills)", dir: join(h, ".agents", "skills", SKILL_NAME) },
  ];
}

/** The skill directory shipped next to the CLI build (packages/cli/skill). */
export function bundledSkillDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, "../skill"), resolve(here, "../../skill"), resolve(here, "../../../skill")]) {
    if (existsSync(join(candidate, "SKILL.md"))) return candidate;
  }
  throw new Error("bundled skill directory not found; rebuild the CLI");
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out.sort();
}
function digest(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

export interface InstallOutcome {
  harness: Harness;
  status: "installed" | "updated" | "skipped_exists" | "skipped_modified" | "unchanged";
  files: number;
}

export function installSkill(target: Harness, opts: { force?: boolean } = {}): InstallOutcome {
  const src = bundledSkillDir();
  const files = walk(src);
  const manifestPath = skillInstallManifest(target.dir);
  if (existsSync(target.dir)) {
    const manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { files: Record<string, string> }) : null;
    if (!manifest && !opts.force) return { harness: target, status: "skipped_exists", files: 0 };
    if (manifest && !opts.force) {
      // Refuse to overwrite user edits: every managed file must still match its recorded hash.
      for (const [rel, sha] of Object.entries(manifest.files)) {
        const p = join(target.dir, rel);
        if (existsSync(p) && digest(p) !== sha) return { harness: target, status: "skipped_modified", files: 0 };
      }
      const same = files.every((rel) => manifest.files[rel] === digest(join(src, rel))) && Object.keys(manifest.files).length === files.length;
      if (same) return { harness: target, status: "unchanged", files: files.length };
    }
    rmSync(target.dir, { recursive: true, force: true });
    mkdirSync(target.dir, { recursive: true });
    cpSync(src, target.dir, { recursive: true });
    writeManifest(target.dir, src, files);
    return { harness: target, status: "updated", files: files.length };
  }
  mkdirSync(target.dir, { recursive: true });
  cpSync(src, target.dir, { recursive: true });
  writeManifest(target.dir, src, files);
  return { harness: target, status: "installed", files: files.length };
}

function writeManifest(dir: string, src: string, files: string[]): void {
  const m = { version: VERSION, installed_at: new Date().toISOString(), files: Object.fromEntries(files.map((rel) => [rel, digest(join(src, rel))])) };
  writeFileSync(skillInstallManifest(dir), JSON.stringify(m, null, 2));
}
