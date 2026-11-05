import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8"));
rmSync(resolve(here, "dist"), { recursive: true, force: true });
mkdirSync(resolve(here, "dist"), { recursive: true });
// The canonical skill lives at the repo root; the published package carries a copy.
rmSync(resolve(here, "skill"), { recursive: true, force: true });
cpSync(resolve(here, "../../skill"), resolve(here, "skill"), { recursive: true });
await build({
  entryPoints: { bctl: "src/main.ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  define: { __BCTL_VERSION__: JSON.stringify(pkg.version) },
  absWorkingDir: here,
  logLevel: "info",
});
