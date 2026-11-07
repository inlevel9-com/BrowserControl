# Set up BrowserControl (for agents)

Follow these steps on the user's machine. Stop and tell the user when a step needs them.

1. **Check prerequisites**: `node --version` must be 22 or newer; `pnpm --version` (install with
   `npm i -g pnpm` if missing).
2. **Build**: in the BrowserControl checkout run `pnpm install && pnpm build`.
3. **Put `bctl` on PATH**: `pnpm -F browser-control link --global`, then verify `bctl --version`.
4. **Install the skill** for the harness you run in: `bctl install-skill --harness claude`
   (or `codex`, `cursor`, `gemini`, `windsurf`, `copilot`, `all`). Tell the user to restart the
   agent so it discovers `browser-control`.
5. **Ask the user to load the extension** in each browser they want to use: extensions page →
   Developer mode → Load unpacked → `packages/extension/dist` → open the popup → Connected.
   Suggest a label per browser (e.g. `work-chrome`, `arc`).
6. **Verify**: `bctl doctor` must show at least one connected browser. If `daemon` fails, run
   `bctl daemon start --foreground` once to read the error.
7. **First task**: `bctl session start --json`, `bctl open https://example.com --session <id>`,
   `bctl snapshot --session <id>`, `bctl session stop <id>`.
8. **Optional, MCP clients** (Claude desktop app chat, Cursor, …): print the configuration with
   `bctl mcp --print-config claude-desktop` (or `claude-code`, `codex`, `json`) and show the user
   where to add it. Do not edit the app's config file without the user's OK.
9. **Optional, recordings**: `ffmpeg -version`. Without ffmpeg, recordings are saved as .avi;
   suggest installing it if the user wants mp4.
