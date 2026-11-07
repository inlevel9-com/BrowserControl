# BrowserControl architecture

Three parts, one wire protocol:

```
agent shell ──► bctl CLI ──JSON lines / UDS──► bctl daemon ──WebSocket 127.0.0.1:52810──► extension (MV3)
MCP client ──► bctl mcp ─┘                         ▲
remote bctl ──TCP 52811, AES-GCM (paired)──────────┘
                                                   │                                        │
                                                   │ identifies the peer process (lsof)      ├─ chrome.scripting  → reads (snapshot, text, html)
                                                   │ per-session queue, tombstones           ├─ chrome.debugger   → trusted input, screenshots, console, network, dialogs
                                                   └─ one daemon, N browsers                 └─ chrome.windows/tabs → Agent Window, borrow/return
```

## bctl CLI (`packages/cli`)

- `bctl <verb> [target] --session <id>`; human output by default, `--json` for agents.
- Talks to the daemon over `$BCTL_HOME/run/daemon.sock` (Unix) or a per-user named pipe
  (Windows) with one newline-terminated JSON request per connection. Socket paths longer than
  the OS limit fall back to `$TMPDIR/bctl-<uid>/<hash>.sock`. With a pairing configured
  (`bctl remote use`, `BCTL_REMOTE`) requests go to the remote daemon instead.
- Auto-starts the daemon (`bctl daemon start --foreground` in a detached child) unless
  `BCTL_AUTO_START=0`.
- `install-skill` copies `skill/` into harness skill directories with a SHA-256 manifest so
  updates never overwrite user edits.

## bctl daemon (same binary)

- Loopback WebSocket server for extensions. `Origin` must be `chrome-extension://<id>`;
  `BCTL_EXTENSION_IDS` optionally pins ids. First frame must be `system.handshake`.
- Browser registry keyed by the extension's persistent `instance_id` (one per browser profile).
  On connect the daemon resolves the peer TCP port to a process (`lsof` on macOS/Linux,
  `Get-NetTCPConnection` on Windows) and derives the vendor from the `.app` name. This is how
  Arc and Dia, whose user agent is plain Chrome, get their real names.
- Sessions: 4-letter ids, bound to one browser, one Agent Window. Tool calls for one session are
  serialised; different sessions run in parallel. Ended sessions leave a tombstone so a late
  CLI call gets `session_user_closed_window` instead of a generic not-found.
- Effect gating: after the user presses **Stop** in the tab overlay, mutating tools are refused
  with `user_aborted`; reads continue; `session resume` clears it.
- Liveness: the extension sends `system.heartbeat` every 20 s; silent peers are pinged and
  reaped after 75 s. Idle sessions stop after `BCTL_SESSION_IDLE_SECS` (default 1800).
- Recordings: `record.frame` events are written to `~/.bctl/recordings/<id>.frames/` and
  encoded on stop with ffmpeg (mp4/webm) or the built-in Motion-JPEG AVI writer. Encoded files
  are kept 7 days.
- Artifacts: recordings and fetched downloads get an id; any CLI (local or remote) copies them
  with chunked `artifact.read`, so `--out` paths are always on the caller's machine.
- Remote access (`remote.ts`): optional TCP listener with a per-client pairing secret, see
  [protocol](protocol.md#remote-link-cli-on-another-machine--daemon).
- State files in `~/.bctl`: `daemon.json`, `daemon.lock`, `daemon.log`, `run/daemon.sock`,
  `recordings/`, `remote.json` (daemon side, 0600), `remote-client.json` (CLI side, 0600).

## bctl mcp

`bctl mcp` is an MCP server over stdio for clients that cannot run shell commands. Each tool
(`browser_open`, `browser_snapshot`, `browser_click`, `browser_tables`, `browser_upload`,
`browser_record`, …) calls the same daemon methods as the CLI. The server starts its own
session on the first browser tool and stops it when the client disconnects.

## Extension (`packages/extension`)

Plain MV3, bundled with esbuild, no framework.

| Module | Role |
| --- | --- |
| `transport.ts` | WebSocket byte pipe with capped backoff reconnect |
| `background.ts` | handshake, heartbeat, dispatch, browser events → daemon events, popup messaging |
| `sessions.ts` | Agent Window creation, borrow/return bookkeeping, tab resolution |
| `page-agent.ts` | self-contained function injected with `chrome.scripting` (isolated world): snapshot with stable `@eN` refs, resolve, find, text/html, scroll, tables, file inputs, DOM fallbacks |
| `cdp.ts` | lazy `chrome.debugger` attach, typed send, console/network/dialog buffers, `sendOrDialog`, event subscriptions |
| `downloads.ts` | attributes `chrome.downloads` items to sessions, waits for completion |
| `recorder.ts` | `Page.startScreencast` per session, frame acks, `record.frame` events |
| `tools.ts` | `tool.*` handlers |
| `keys.ts` | key combo → CDP key events |
| `content.ts` | control overlay with Stop button in controlled tabs |
| `popup.ts` | status, port, label, instance id, sessions |

Design rules:

- **Reads never need the debugger.** Snapshots, text, HTML, find, waits, and scrolling run in
  the isolated world, so they work even where `chrome.debugger` is refused.
- **Input is trusted when possible.** Click, press, type, and fill use CDP `Input.*` so
  `isTrusted` is true and frameworks behave as with a real user. When attach fails the tool
  falls back to DOM events and reports `via: "dom"`.
- **Dialogs never hang a call.** Input commands race the `Page.javascriptDialogOpening` event;
  the action returns with `dialog` set and every later call fails with `dialog_pending` until
  the agent decides it.
- **Refs are stable per document.** The page agent keeps a `WeakMap<Element, ref>`, so the same
  element keeps its `@eN` across snapshots until navigation.
- **Sandbox.** Tools act only on tabs inside the session's Agent Window or explicitly borrowed
  tabs. Other sessions' windows are invisible. Borrowed tabs cannot be closed.

## Browser coverage

| Browser | UA detection | Daemon process identity | Notes |
| --- | --- | --- | --- |
| Chrome | `Chrome/` | Google Chrome | |
| Edge | `Edg/` | Microsoft Edge | |
| Whale | `Whale/` | Whale | |
| Brave | `navigator.brave` / brands | Brave Browser | |
| Arc | none (looks like Chrome) | Arc | named by the daemon |
| Dia | none (looks like Chrome) | Dia | named by the daemon |
| Opera, Vivaldi, Yandex | UA token | app name | untested |

Branded Google Chrome 137+ ignores `--load-extension`; load unpacked through the extensions
page instead. The e2e suite uses Chrome for Testing / Chromium for that reason.

## Repository layout

```
BrowserControl/
├── packages/protocol/   # wire types, methods, error codes, browser detection helpers
├── packages/extension/  # MV3 extension (esbuild) → dist/
├── packages/cli/        # bctl CLI + daemon (esbuild) → dist/bctl.mjs; bundles skill/
├── skill/               # canonical browser-control SKILL.md + references/
├── docs/                # architecture, protocol, browser notes, store listing
└── tests/e2e/           # real-browser end-to-end suite
```
