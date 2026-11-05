// Bundles the MV3 extension with esbuild. No framework: background service worker,
// popup, and one content script. Static files are copied from public/.
import { build, context } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = process.env.BCTL_EXT_OUT ? resolve(process.env.BCTL_EXT_OUT) : resolve(here, "dist");
const pkg = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8"));
const watch = process.argv.includes("--watch");
const wsUrl = process.env.BCTL_DAEMON_WS_URL ?? "ws://127.0.0.1:52810";

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(resolve(here, "public"), dist, { recursive: true });
const manifest = JSON.parse(readFileSync(resolve(here, "manifest.json"), "utf8"));
manifest.version = pkg.version;
writeFileSync(resolve(dist, "manifest.json"), JSON.stringify(manifest, null, 2));

const opts = {
  entryPoints: {
    background: "src/background.ts",
    popup: "src/popup.ts",
    content: "src/content.ts",
  },
  bundle: true,
  format: "esm",
  target: "chrome125",
  outdir: dist,
  sourcemap: watch ? "inline" : false,
  minify: false,
  logLevel: "info",
  define: {
    __BCTL_EXT_VERSION__: JSON.stringify(pkg.version),
    __BCTL_DAEMON_WS_URL__: JSON.stringify(wsUrl),
  },
  absWorkingDir: here,
};

if (watch) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log("watching…");
} else {
  await build(opts);
  console.log(`built → ${dist}`);
}
