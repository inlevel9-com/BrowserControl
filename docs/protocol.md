# Wire protocol 1.0

Frames (both links):

```jsonc
{ "id": "c1", "method": "tool.click", "params": { "session_id": "abcd", "target": "@e3" } }
{ "id": "c1", "result": { "tab_id": 12, "target": "@e3", "via": "cdp" } }
{ "id": "c1", "error": { "code": "not_found", "message": "ref @e3 unknown", "data": { "reason": "ref_not_found", "hint": "run bctl snapshot" } } }
{ "event": "session.user_interrupt", "payload": { "session_id": "abcd", "tab_id": 12 } }
```

Error codes: `unknown_method unsupported invalid_params not_found permission_denied timeout
dialog_pending cdp_failed protocol_error cancelled user_aborted version_mismatch
multiple_browsers_online no_browser_connected browser_disconnected internal`.
`data.reason` is a stable machine string; `data.hint` is agent-facing recovery text.

## CLI → daemon

| Method | Params | Result |
| --- | --- | --- |
| `system.ping` | – | `{pong, version, protocol_version, pid}` |
| `system.status` | – | `StatusResult` |
| `system.shutdown` | – | `{ok}` |
| `browser.list` | – | `{browsers: BrowserEntry[]}` |
| `session.start` | `{browser?, focused?, width?, height?, incognito?, controller?}` | `{session_id, browser_instance_id, browser, agent_window_id, active_tab_id}` |
| `session.stop` / `session.stop_all` / `session.list` / `session.resume` | | |
| `tool.wait_ms` | `{ms}` | `{waited_ms}` (served by the daemon) |
| `tool.*` | see below; daemon injects nothing, forwards as-is | |

## Daemon ↔ extension

Extension sends `system.handshake` first:
`{client, version, protocol_version, instance_id, browser:{name,version,chromium?,detected_by?}, label}`
→ `{server, version, protocol_version, process?:{pid,name,browser?,path?}}`.

Events from the extension: `system.heartbeat` (20 s), `session.window_closed`,
`session.user_interrupt`, `dialog.changed`. Daemon → extension requests: every `tool.*`,
`system.ping`, and `cancel {rpc_id}`.

## Tools

All take `session_id`; tab-scoped ones accept `tab_id` (default: the session's active tab).
Targets are `@eN` refs from `tool.snapshot` or CSS selectors (main document; shadow roots are
traversed for snapshots).

| Method | Params (beyond scope) | Result highlights |
| --- | --- | --- |
| `tool.session_start` | `focused, width, height, incognito, controller` | `agent_window_id, active_tab_id` |
| `tool.session_stop` | | `returned_tabs, closed_tabs` |
| `tool.tab_list` | `scope: user\|agent\|all` | `tabs[{tab_id, window_id, title, url, active, scope, borrowed}]` |
| `tool.tab_create` | `url, active` | `tab_id` |
| `tool.tab_close` / `tab_select` / `tab_borrow` / `tab_return` | `tab_id` | |
| `tool.window_resize` | `width, height` | |
| `tool.navigate` | `url, wait_until, timeout_ms` | `url, title, status: complete\|timeout` |
| `tool.navigate_back` / `navigate_forward` / `reload` | | same |
| `tool.snapshot` | `mode: interactive\|full, max_chars, root` | `text, observation_id, ref_count, truncated, dialog?` |
| `tool.find` | `query, limit` | `matches[{ref, role, name}]` |
| `tool.get_text` / `get_html` | `target?, max_chars` | |
| `tool.screenshot` | `target?, full_page?, format, quality` | base64 `data`, `via: cdp\|tabs_api` |
| `tool.click` | `target, button, click_count, modifiers, dom` | `via, navigated_to?, dialog?` |
| `tool.hover` / `scroll_to` | `target` | |
| `tool.fill` | `target, value, submit` | |
| `tool.type` | `text, delay_ms` | |
| `tool.press` | `key, target?` | |
| `tool.select` | `target, values[]` | `selected[]` |
| `tool.check` | `target, checked` | `checked` |
| `tool.scroll` | `target?, delta_x, delta_y, to: top\|bottom` | `scroll_x, scroll_y, at_bottom` |
| `tool.evaluate` | `expression, world, timeout_ms` | `value, type` |
| `tool.console` | `since_seq, level, limit, clear` | `entries[], capturing` |
| `tool.network` | `since_seq, filter, limit, clear, body_for` | `entries[], body?` |
| `tool.wait_for_element` | `target, state, timeout_ms` | `matched, elapsed_ms` |
| `tool.wait_for_navigation` | `url_includes, timeout_ms` | `url, reached` |
| `tool.dialog_status` / `dialog_handle` | `accept, text` | |
| `tool.cookies` | `domain?` | names and flags only, never values |
| `tool.pdf` | `landscape` | base64 PDF |

Snapshot line format:

```
- role "accessible name" @eN [attr=value …]
  - text: "visible text"
```
