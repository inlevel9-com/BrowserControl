<p align="center">
  <img src="packages/extension/public/icons/icon128.png" alt="BrowserControl icon" width="128" height="128" />
</p>

<h1 align="center">BrowserControl</h1>

**Your agent, your Chromium browsers, one CLI.** BrowserControl lets any shell-capable AI agent
(Claude Code, Codex, Cursor, Gemini CLI, Windsurf, …) drive the browsers you already use, with
your existing logins, in a separate **Agent Window** you can watch and stop at any time.

Built for the Chromium family: **Chrome, Edge, Whale, Brave, Arc, Dia** and other
Chromium 125+ browsers connect to one local daemon; the agent picks a browser by name.

```
agent ──bctl──► daemon ──ws://127.0.0.1:52810──► extension (MV3) ──► your browser
```

- `bctl` CLI + daemon (Node 22+, TypeScript, two runtime dependencies)
- MV3 extension (plain TypeScript, esbuild)
- `browser-control` skill that teaches agents the workflow
- Real-browser end-to-end suite (20 scenarios: trusted input, dialogs, console/network, borrow/return)

## Quick start

```sh
pnpm install && pnpm build            # protocol, extension → packages/extension/dist, CLI → packages/cli/dist
pnpm -F browser-control link --global  # puts `bctl` on PATH (or: node packages/cli/bin/bctl.js)
bctl install-skill --harness claude   # ~/.claude/skills/browser-control (codex, cursor, gemini, windsurf, copilot, all)
```

Load the extension once per browser: extensions page → Developer mode → **Load unpacked** →
`packages/extension/dist`. Open its popup; it should read **Connected** (the daemon starts with
the first `bctl` command, or run `bctl daemon start`).

```sh
bctl doctor                         # node, daemon, installed browsers, connected browsers, skill
bctl browsers                       # pick one with --browser <id|label|chrome|edge|whale|brave|arc|dia>
bctl session start --json --browser arc
bctl open https://example.com --session <id>
bctl snapshot --session <id>        # outline with @eN refs
bctl click @e3 --session <id>
bctl fill @e5 "hello" --submit --session <id>
bctl screenshot --out page.png --session <id>
bctl session stop <id>
```

Then ask your agent:

```text
Use browser-control to open https://example.com in Whale, summarize the page, and stop the session.
```

## Commands

| Area | Commands |
| --- | --- |
| Lifecycle | `daemon start|stop`, `status`, `doctor`, `logs`, `browsers`, `session start|stop|list|resume` |
| Tabs | `tab list|new|select|close|borrow|return`, `window <w> <h>` |
| Navigate | `open <url>`, `back`, `forward`, `reload` |
| Read | `snapshot`, `find <query>`, `text [target]`, `html [target]`, `screenshot`, `pdf`, `eval <js>` |
| Act | `click`, `hover`, `fill`, `type`, `press`, `select`, `check|uncheck`, `scroll`, `scroll-to` |
| Wait | `wait element|nav|ms` |
| Debug | `console`, `network [--body id]`, `dialog status|accept|dismiss`, `cookies` (names only) |
| Agents | `install-skill [--harness …] [--list] [--force]` |

Every command accepts `--session <id>` (or `BCTL_SESSION`), `--tab <id>`, and `--json`.

## How it stays safe

- Actions are confined to the session's Agent Window and explicitly borrowed tabs; other
  sessions' windows are invisible; borrowed tabs are returned on stop and can never be closed.
- A **Stop** button in every controlled tab blocks further actions until the user says otherwise.
- Cookie values, passwords, and tokens are never returned by any command.
- The daemon only accepts loopback WebSocket connections whose `Origin` is a Chromium extension;
  `BCTL_EXTENSION_IDS` pins specific ids.
- The skill tells agents that page content is data, never instructions.

## Development

```sh
pnpm typecheck && pnpm test     # unit tests (node:test)
pnpm e2e                        # real Chromium + unpacked extension + daemon + CLI
pnpm e2e -- --headful           # watch it
pnpm e2e -- --browser "/Applications/Whale.app/Contents/MacOS/Whale"
```

See [docs/architecture.md](docs/architecture.md), [docs/protocol.md](docs/protocol.md),
[docs/browsers.md](docs/browsers.md), and [skill/SKILL.md](skill/SKILL.md).

## Status

v1.0.0. Not yet implemented, by design: file upload/download, video recording, structured
table extraction, remote (server-side daemon) pairing, MCP server mode. Windows named-pipe IPC
and process identity are written but untested.

MIT.
