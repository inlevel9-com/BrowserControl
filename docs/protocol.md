# Wire protocol 1.1

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
| `session.resume` | `{session_id}` | `{session_id, interrupted: false}` |
| `tool.wait_ms` | `{ms}` | `{waited_ms}` (served by the daemon) |
| `record.start` | `{session_id, tab_id?, format: mp4\|webm\|avi, max_secs, quality, max_width, max_height}` | `{recording_id, tab_id, max_secs}` |
| `record.stop` | `{session_id, format?}` | `{recording_id, artifact, frames, duration_ms, format, encoder, reason}` |
| `download.fetch` | `{session_id, download_id}` | `ArtifactInfo` for a completed session download |
| `artifact.read` | `{artifact_id, offset, length ≤ 4 MiB}` | `{data (base64), offset, size, eof}` |
| `artifact.list` | `{session_id?}` | `{artifacts}` |
| `remote.status` / `remote.reload` | – | `{enabled, listening?, clients}` (local socket only) |
| `tool.*` | see below; daemon injects nothing, forwards as-is | |

## Daemon ↔ extension

Extension sends `system.handshake` first:
`{client, version, protocol_version, instance_id, browser:{name,version,chromium?,detected_by?}, label}`
→ `{server, version, protocol_version, process?:{pid,name,browser?,path?}}`.

Events from the extension: `system.heartbeat` (20 s), `session.window_closed`,
`session.user_interrupt`, `dialog.changed`, `record.frame`
`{session_id, recording_id, data (base64 JPEG), ts, width?, height?}`, and `record.ended`
`{session_id, recording_id, reason}`. Daemon → extension requests: every `tool.*`,
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
| `tool.upload` | `target, files[{name, mime, data}]` | `via: input\|chooser, files[], multiple` |
| `tool.download` | `url \| target, filename?` | `download: DownloadInfo` |
| `tool.downloads` | `download_id?, wait, since_ms, timeout_ms` | `downloads[], waited?, timed_out?` |
| `tool.tables` | `target?, max_rows` | `tables[{index, ref, kind, caption?, headers[], rows[][], row_count, column_count, truncated}]` |
| `tool.record_start` / `tool.record_stop` | `recording_id` (daemon-internal) | |

`tool.upload` sets files directly on an `<input type=file>` (the target itself, a label's
control, or the only file input inside the target). Otherwise it clicks the target with the
file chooser intercepted (`Page.setInterceptFileChooserDialog`) and sets the files on the input
the chooser reports. Bytes travel inside the request, so the CLI's machine supplies the files.

Downloads are only listed for the session that caused them: started with `tool.download`, or
triggered in a controlled tab (matched through `Page.downloadWillBegin` or the referrer).

## Remote link (CLI on another machine → daemon)

Enabled with `bctl remote enable`; TCP on `127.0.0.1:52811` by default. Each connection carries
one request:

```
C → S   {"proto":"bctl-remote/1","client_id":"…","nonce":"<32 bytes, base64>"}\n
S → C   {"proto":"bctl-remote/1","nonce":"<32 bytes, base64>"}\n
keys    HKDF-SHA256(pairing secret, salt = nonce_c ‖ nonce_s, info "bctl-remote/1 keys") → c2s ‖ s2c
C → S   u32 length ‖ AES-256-GCM(c2s, iv = 1 ‖ counter, aad "bctl-remote/1", request frame)
S → C   u32 length ‖ AES-256-GCM(s2c, iv = 2 ‖ counter, …, response frame)
```

A client without the secret cannot produce a frame the daemon opens, and the daemon proves it
holds the secret by answering. Unknown client ids get the same handshake and fail at the first
frame. Remote callers cannot use `system.shutdown` or `remote.*`; sessions they start carry
`remote: <name>` in the controller label shown on the tab overlay.

Snapshot line format:

```
- role "accessible name" @eN [attr=value …]
  - text: "visible text"
```
