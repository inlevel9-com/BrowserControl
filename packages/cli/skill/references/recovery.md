# Recovery

Every error has `code`, `message`, and often `data.reason` and `data.hint`. Read the hint first.

| reason | What it means | Do |
| --- | --- | --- |
| `session_not_found`, `session_stopped`, `session_user_closed_window`, `session_browser_disconnected` | The session is gone | Report why; start a new session only if the task should continue |
| `ref_not_found` | Refs expired (navigation) or wrong ref | `bctl snapshot`, use fresh refs |
| `selector_not_found` | CSS selector matched nothing | `bctl find` / snapshot and use a ref |
| `target_hidden`, `target_disabled` | Element exists but is not actionable | Scroll, open the menu that reveals it, or wait; do not force a DOM click unless the user agrees |
| `dialog_pending` | Native dialog open | `bctl dialog accept|dismiss`; never repeat the action |
| `restricted_tab_url` | chrome://, store, or extension page | Navigate to an http(s) page |
| `cdp_unavailable`, `cdp_attach_failed` | Debugger cannot attach (DevTools open, policy, Arc/Dia restrictions) | Close DevTools; reads still work; clicks fall back to DOM events automatically |
| `user_interrupt` | User pressed Stop | Ask the user; `session resume` only on their say-so |
| `extension_timeout` | Page hung or dialog | `bctl dialog status`, `bctl reload` |
| `multiple_browsers_online`, `no_browser_connected` | Browser selection | See tabs-and-browsers / environment |
| `daemon_start_failed` | Daemon could not start | `bctl daemon start --foreground` to see the error; check port with `BCTL_PORT` |

## Stuck pages

1. `bctl dialog status`; decide any dialog.
2. `bctl screenshot` and `bctl snapshot` to see the actual state (consent banners, modals).
3. `bctl wait element <target> --timeout 10000` instead of repeated clicks.
4. If a login, CAPTCHA, OTP, or payment step appears, stop and ask the user to do it in the
   Agent Window (`bctl session start --focus` next time if they want to watch).
5. After two failed attempts at the same step, change the approach (different element, keyboard
   navigation, direct URL) or report; do not loop.

Always finish with `bctl session stop <id>`, also after failures.

## Files

- `upload` fails with `input_not_multiple`: the input takes one file; upload one at a time or ask
  which file the user wants.
- `no_file_chooser`: the target neither is a file input nor opened a picker when clicked. Find the
  input with `bctl find file`, or `bctl upload "input[type=file]" …`.
- `downloads wait` times out: the click may not have started a download (check `bctl network`),
  or the browser asks where to save each file — ask the user to turn that off or to save it.
- `download_not_in_session`: only downloads started from this session's tabs can be fetched.
