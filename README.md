<p align="center">
  <img src="packages/extension/public/icons/icon128.png" alt="BrowserControl icon" width="128" height="128" />
</p>

<h1 align="center">BrowserControl</h1>

<p align="center">
  <b>Let your AI agent use the browser you already use — with your logins, in a window you can watch and stop.</b><br/>
  English · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="docs/images/agent-window.png" alt="An Agent Window controlled by Codex, with the BrowserControl badge and Stop button in the top-right corner" width="720" />
</p>

You ask your agent (Claude Code, Codex, Cursor, Gemini CLI, the Claude desktop app, …) to do
something on the web. It opens a separate **Agent Window** in your own Chrome, Edge, Whale,
Brave, Arc or Dia, clicks and types like a person, uploads and downloads files, reads tables,
records video if you want, and reports back. Every controlled tab shows a badge with a
**Stop** button. Your own tabs stay untouched unless you lend one.

## Contents

1. [How it works](#how-it-works)
2. [Which AI tools can use it?](#which-ai-tools-can-use-it)
3. [Install (once)](#install-once)
4. [Use it with Claude Code](#use-it-with-claude-code)
5. [Use it with Codex](#use-it-with-codex)
6. [MCP clients (Claude desktop chat, Cursor, …)](#mcp-clients-claude-desktop-chat-cursor-)
7. [ChatGPT / Claude chat users](#chatgpt--claude-chat-users)
8. [Browser on another computer](#browser-on-another-computer)
9. [What to ask for](#what-to-ask-for)
10. [Try it by hand](#try-it-by-hand) · [Command reference](#command-reference)
11. [Safety](#safety) · [Troubleshooting](#troubleshooting) · [Development](#development)

## How it works

```
 you ──ask──► AI agent ──runs `bctl` (or `bctl mcp`)──► helper ─────127.0.0.1──► extension ──► your browser
                                                        (your computer)                         (Agent Window)
```

Three pieces, all on your computer:

| Piece | What it is | You install it… |
| --- | --- | --- |
| **`bctl`** | Command-line tool the agent runs. | once |
| **Helper** | A small background program that links the agent and the browser. `bctl` starts it by itself; it runs quietly on your computer. Commands call it the `daemon`. | nothing to install (comes with `bctl`) |
| **Extension** | Receives `bctl` requests and acts in the Agent Window. | once per browser |
| **Skill** | Instructions that teach your agent how to use `bctl` safely. | once per agent |

Nothing goes through a server. No account, no analytics. (Optionally, you can let a `bctl` on
another machine you own reach your helper: see [Browser on another computer](#browser-on-another-computer).)

## Which AI tools can use it?

BrowserControl works with any AI agent that **can run commands on your computer** (through the
`bctl` CLI) or **can use a local MCP server** (through `bctl mcp`).

| You use… | Works? | Notes |
| --- | --- | --- |
| Claude Code (terminal, VS Code/JetBrains, Claude desktop app's **Code** tab) | ✅ | [Setup](#use-it-with-claude-code) |
| Codex (CLI, IDE extension, Codex app) | ✅ | [Setup](#use-it-with-codex) |
| Claude desktop app **chat** (macOS, Windows) | ✅ via MCP | [Setup](#mcp-clients-claude-desktop-chat-cursor-) |
| Cursor, Gemini CLI, Windsurf, GitHub Copilot CLI | ✅ | Skill (`install-skill`) or MCP |
| ChatGPT or Claude **web/mobile chat** (chatgpt.com, claude.ai in a browser or phone) | ❌ directly | These run in the cloud and can't reach your computer. [What to do instead](#chatgpt--claude-chat-users) |

## Install (once)

You need **Node.js 22+** and a Chromium 125+ browser. For mp4/webm recordings, also
[ffmpeg](https://ffmpeg.org/download.html) (optional; without it recordings are saved as .avi).

> **Shortcut:** after `git clone` (step 1), open the `BrowserControl` folder in Claude Code or
> Codex and say *"Follow AGENT_INSTALL.md to set up BrowserControl."*
> The agent does the rest and tells you when to do step 3, which needs your hands.

**1. Get the code and build it**

```sh
git clone https://github.com/inlevel9-com/BrowserControl.git
cd BrowserControl
npm i -g pnpm            # skip if you already have pnpm
pnpm install && pnpm build
```

**2. Put `bctl` on your PATH**

```sh
pnpm -F browser-control link --global
bctl --version
```

**3. Load the extension in each browser you want the agent to use**

1. Open the extensions page (`chrome://extensions`, `edge://extensions`, `whale://extensions`,
   `brave://extensions`; in Arc/Dia type `chrome://extensions` in the address bar).
2. Turn on **Developer mode** → **Load unpacked** → choose `packages/extension/dist`.
3. Click the BrowserControl icon. Optionally give it a label like `work-chrome`.
   It shows **Connected** once the helper is running (step 5 starts it).

> The extension is under Chrome Web Store review. Until it is listed, use **Load unpacked**.
> Version 1.1 adds the `downloads` permission; when you update an unpacked copy, click the
> reload icon on the extensions page.

**4. Teach your agent (install the skill)**

```sh
bctl install-skill --harness claude    # Claude Code
bctl install-skill --harness codex     # Codex
bctl install-skill --list              # all options: cursor, gemini, windsurf, copilot, all …
```

Restart the agent afterwards so it picks the skill up.

**5. Check everything**

```sh
bctl doctor
```

You want to see the helper running (`daemon`), at least one **connected browser**, and the skill installed.

## Use it with Claude Code

Applies to Claude Code in the terminal, in VS Code/JetBrains, and in the Claude desktop app's
**Code** tab — they share the same `~/.claude` folder.

1. Install the skill: `bctl install-skill --harness claude`, then start a new Claude Code session.
2. Just ask. Mentioning "browser" or "BrowserControl" is enough for Claude to load the
   `browser-control` skill. You can also call it directly with `/browser-control`.

   ```text
   Open https://news.ycombinator.com in my browser and list the top 5 stories.
   ```

3. Claude asks before running each `bctl` command. To stop the prompts, allow it once
   ("Yes, and don't ask again for bctl") or add this to `.claude/settings.json`:

   ```json
   { "permissions": { "allow": ["Bash(bctl:*)"] } }
   ```

- Want the skill only for one project? `bctl install-skill --harness claude-project` (writes to
  `./.claude/skills`).
- Several browsers connected? Say which: *"use Whale"*, *"use my work-chrome"*.

## Use it with Codex

Applies to the Codex CLI, the Codex IDE extension and the Codex app.

1. Install the skill: `bctl install-skill --harness codex` (writes to `~/.codex/skills`), then
   restart Codex.
2. **Start the helper yourself first**, in a normal terminal:

   ```sh
   bctl daemon start
   ```

   Codex runs commands in a sandbox by default. The sandbox can block `bctl` from starting the
   helper or writing to `~/.bctl`, so having it already running avoids most problems.
3. Ask Codex, mentioning the browser:

   ```text
   Use BrowserControl to open http://localhost:3000/signup and check that
   the form shows an error for an invalid email.
   ```

4. If `bctl` still fails with a permission or connection error, approve the command when Codex
   asks to run it outside the sandbox. Run `bctl doctor` in your own terminal to confirm the
   browser shows as connected.

## MCP clients (Claude desktop chat, Cursor, …)

`bctl mcp` runs BrowserControl as a [Model Context Protocol](https://modelcontextprotocol.io)
server, so apps that can't run shell commands but can use local MCP servers get the same
browser tools (`browser_open`, `browser_snapshot`, `browser_click`, `browser_fill`,
`browser_tables`, `browser_upload`, `browser_download`, `browser_record`, …).

`bctl mcp --print-config <client>` prints the exact configuration with absolute paths, so the
app finds Node and `bctl` even without your shell's PATH:

| Client | Do this |
| --- | --- |
| Claude desktop app (chat) | Settings → Developer → Edit Config, then merge in the output of `bctl mcp --print-config claude-desktop`. Restart the app. |
| Claude Code | Run the command printed by `bctl mcp --print-config claude-code`. (Or use the skill — either works.) |
| Codex | Run the command printed by `bctl mcp --print-config codex`, or paste its TOML into `~/.codex/config.toml`. |
| Cursor and other JSON-configured clients | Merge `bctl mcp --print-config json` into the client's MCP config. |

Then ask in chat: *"Open example.com in my browser and summarize it."* The server opens its own
Agent Window on the first browser tool and closes it when the app disconnects. Options:
`--browser <id|label|name>` picks a browser, `--focus` brings the window to the front,
`--keep-session` leaves it open.

## ChatGPT / Claude chat users

The chat on **chatgpt.com**, **claude.ai** in a web browser, and the mobile apps runs in the
cloud. It cannot reach `bctl` on your computer, so it cannot drive your browser. You have four
options:

| Option | Who it's for | How |
| --- | --- | --- |
| **Claude desktop app → chat + MCP** | Claude users who want to stay in normal chat | Install the [Claude desktop app](https://claude.ai/download), do the [install](#install-once) steps (or let Claude Code / Codex do them), then add BrowserControl as an [MCP server](#mcp-clients-claude-desktop-chat-cursor-). |
| **Claude desktop app → Code tab** | Claude subscribers who prefer an app over a terminal | Install the [Claude desktop app](https://claude.ai/download), open the **Code** tab, pick the cloned BrowserControl folder, and say *"Follow AGENT_INSTALL.md to set up BrowserControl."* Then follow [Claude Code](#use-it-with-claude-code). |
| **Codex** | ChatGPT subscribers | Sign in to Codex (app, CLI or IDE extension) with your ChatGPT account, open the cloned BrowserControl folder, and ask it to follow `AGENT_INSTALL.md`. Then follow [Codex](#use-it-with-codex). |
| **Chat as a setup guide only** | Anyone | Paste [AGENT_INSTALL.md](AGENT_INSTALL.md) into the chat and ask it to walk you through each step. You run the commands; the chat can explain errors. It still can't control the browser. |

## Browser on another computer

Run the agent on one machine (a dev box, a VM, a server you SSH into) and let it use the
browser on your own computer. Pair them once:

1. **On the computer with the browser:**

   ```sh
   bctl remote pair --name devbox
   ```

   This turns on remote access (listening on `127.0.0.1:52811`) and prints a command with a
   one-time-shown pairing secret.
2. **Make the port reachable from the other machine.** The simplest way is an SSH tunnel
   started on the browser's computer:

   ```sh
   ssh -N -R 52811:127.0.0.1:52811 you@devbox
   ```

   On a private network such as Tailscale you can instead listen on that address:
   `bctl remote enable --host <tailscale-ip>`, then
   `bctl remote pair --name devbox --connect-host <tailscale-ip>`.
3. **On the other machine** (with `bctl` installed and the skill or MCP set up there):

   ```sh
   bctl remote use 'bctl1.…@127.0.0.1:52811'
   bctl status          # shows "remote daemon at 127.0.0.1:52811" and your browsers
   ```

Every `bctl` command there now goes to your browser. Uploads read files on the agent's machine,
and `--out` for downloads and recordings saves on the agent's machine.

The connection is encrypted and authenticated with the pairing secret (AES-256-GCM, fresh keys
per connection). A paired machine can control your browser like a local agent, but cannot stop
your helper or change remote settings. Manage it with `bctl remote status`, `bctl remote revoke
devbox`, and `bctl remote disable`; on the other machine, `bctl remote forget` goes back to local.

## What to ask for

Write requests the way you'd brief a person. Say which site, what to do, and what to bring back.

```text
Open my Gmail in Chrome, find the latest invoice email from Acme, and tell me the amount.
Do not reply or delete anything.
```

```text
Go to http://localhost:5173, click through the checkout with the test card,
and show me any console errors or failed network requests.
```

```text
I have a Notion page open in a tab. Borrow that tab, copy the table of contents
into a markdown list, then give the tab back.
```

```text
Use Whale. Compare the prices of "AirPods Pro 2" on the first page of search results
on three shopping sites and make a table.
```

```text
On our admin page, upload ~/Desktop/receipts/*.pdf to the expense form,
then download the generated report into ~/Downloads/reports.
```

```text
Open the sales dashboard and give me the "Monthly revenue" table as CSV.
```

```text
Record a video while you reproduce the checkout bug on localhost:3000, and save it as bug.mp4.
```

Tips:

- The agent works in its own Agent Window, so you can keep using your browser.
- It uses your existing logins. If a site needs a login, OTP, CAPTCHA or payment, the agent
  stops and asks you to do that part in the Agent Window.
- Press **Stop** on the badge at any time. The agent is blocked until you tell it to continue.

## Try it by hand

Useful to check the setup, or if you'd like to see what the agent does.

```sh
bctl browsers                              # which browsers are connected
bctl session start --browser chrome        # opens an Agent Window, prints a session id
export BCTL_SESSION=<session id>
bctl open https://example.com
bctl snapshot                              # page outline; clickable things get refs like @e3
bctl click @e3
bctl fill @e5 "hello" --submit
bctl screenshot --out page.png
bctl tables --format csv                   # every table on the page as rows and columns
bctl upload "input[type=file]" ./photo.jpg # or the button that opens the file picker
bctl download @e9 --out ./report.pdf       # a link or URL, with the browser's logins
bctl record start                          # … do things …
bctl record stop --out demo.mp4
bctl session stop $BCTL_SESSION            # closes the Agent Window
```

## Command reference

| Area | Commands |
| --- | --- |
| Lifecycle | `daemon start\|stop`, `status`, `doctor`, `logs`, `browsers`, `session start\|stop\|list\|resume` |
| Tabs | `tab list\|new\|select\|close\|borrow\|return`, `window <w> <h>` |
| Navigate | `open <url>`, `back`, `forward`, `reload` |
| Read | `snapshot`, `find <query>`, `text [target]`, `html [target]`, `tables [target]`, `screenshot`, `pdf`, `eval <js>` |
| Act | `click`, `hover`, `fill`, `type`, `press`, `select`, `check\|uncheck`, `scroll`, `scroll-to` |
| Files | `upload <target> <files…>`, `download <url\|target> [--out]`, `downloads [list\|wait\|get]` |
| Video | `record start [--format mp4\|webm\|avi]`, `record stop [--out]` |
| Wait | `wait element\|nav\|ms` |
| Debug | `console`, `network [--body id]`, `dialog status\|accept\|dismiss`, `cookies` (names only) |
| Agents | `install-skill [--harness …] [--list] [--force]`, `mcp [--print-config <client>]` |
| Remote | `remote enable\|disable\|pair\|revoke\|status` (browser's machine), `remote use\|forget` (agent's machine) |

Every command accepts `--session <id>` (or `BCTL_SESSION`), `--tab <id>`, and `--json`.
`bctl <command> --help` lists the flags.

## Safety

- The agent acts only in its Agent Window and in tabs you explicitly lend. Lent tabs are
  returned when the session ends and are never closed.
- A **Stop** button on every controlled tab blocks further actions until you allow them again.
- No command returns cookie values, passwords or tokens.
- Downloads are reported only for the session that started them; your other downloads stay
  private.
- Remote access is off until you pair a machine, listens on loopback by default, and every
  connection must prove it holds that machine's pairing secret. Revoke it any time.
- The helper listens only on `127.0.0.1` (inside your computer) and only accepts connections from Chromium extensions.
  `BCTL_EXTENSION_IDS` can pin specific extension ids.
- The skill tells the agent that page content is data, never instructions.

Details: [PRIVACY.md](PRIVACY.md).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `bctl: command not found` | Re-run `pnpm -F browser-control link --global`, then open a new terminal / restart the agent. Or use `node packages/cli/bin/bctl.js`. |
| Extension popup isn't **Connected** | Run any `bctl` command (e.g. `bctl doctor`) or `bctl daemon start`. Check the port in the popup matches `BCTL_PORT` (default 52810). |
| `bctl doctor` shows no browser | Load the extension in that browser (step 3) and open its popup once. |
| Agent doesn't know about BrowserControl | Run `bctl install-skill --harness <your agent>` and restart the agent. |
| Helper won't start | `bctl daemon start --foreground` shows the error. `bctl logs -n 100` shows recent logs. |
| Actions fail with `user_aborted` | Someone pressed **Stop**. Tell the agent to continue; it runs `bctl session resume <id>`. |
| "started debugging this browser" bar | Normal while the agent controls a tab. It disappears when the session stops. |
| Recording saved as `.avi` instead of `.mp4` | ffmpeg isn't on PATH. Install it, or point `BCTL_FFMPEG` at it. |
| Recording has few frames | Frames are captured when the page repaints, and background windows may not paint. Start the session with `--focus`. |
| `downloads wait` times out | The browser may ask where to save each file. Turn off "Ask where to save each file" in its settings, or save it by hand. |
| `remote_auth_failed` | The pairing was revoked or mistyped. Pair again with `bctl remote pair`. |
| Remote `status` can't connect | Is the SSH tunnel up? On the browser's machine, `bctl remote status` shows where it listens. |
| MCP tools don't appear | Use the absolute paths from `bctl mcp --print-config …` and restart the app. |

Per-browser notes: [docs/browsers.md](docs/browsers.md).

## Development

```sh
pnpm typecheck && pnpm test     # unit tests (node:test)
pnpm e2e                        # real Chromium + unpacked extension + helper + CLI
pnpm e2e -- --headful           # watch it
pnpm e2e -- --browser "/Applications/Whale.app/Contents/MacOS/Whale"
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs typecheck, unit tests and the
real-browser e2e suite on Linux, macOS and Windows (named-pipe IPC and process identity included).

Docs: [architecture](docs/architecture.md), [protocol](docs/protocol.md),
[browsers](docs/browsers.md), [skill](skill/SKILL.md).

## License

[Apache License 2.0](LICENSE).
