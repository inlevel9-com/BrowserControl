# Browser notes

BrowserControl targets any Chromium 125+ browser. One daemon serves every connected browser;
each browser profile is one extension instance with its own `instance_id` and optional label.

## Installing the extension (all browsers)

1. `pnpm build` → `packages/extension/dist` (or `pnpm -F @browser-control/extension zip`).
2. Open the extensions page, enable **Developer mode**, click **Load unpacked**, pick `dist`.
3. Open the popup, confirm **Connected**, set a label (e.g. `work-chrome`).
4. `bctl browsers` shows it; `bctl session start --browser work-chrome`.

| Browser | Extensions page | Identified as | Verified |
| --- | --- | --- | --- |
| Google Chrome | `chrome://extensions` | `chrome` (UA) | e2e on Chrome for Testing 156 |
| Microsoft Edge | `edge://extensions` | `edge` (UA `Edg/`) | by UA parsing only |
| Naver Whale | `whale://extensions` | `whale` (UA `Whale/`) | by UA parsing only |
| Brave | `brave://extensions` | `brave` (`navigator.brave`, brands) | by API parsing only |
| Arc | type `chrome://extensions` in the command bar | `arc` (daemon process identity) | process-name mapping only |
| Dia | type `chrome://extensions` in the address bar | `dia` (daemon process identity) | process-name mapping only |
| Opera / Vivaldi / Yandex / Chromium | their `://extensions` page | UA token | untested |

"Verified" lists what this repository's tests cover. The other rows rely on detection code paths
that have unit tests but no live run yet; `bctl browsers` output is the way to confirm each one.

## Per-browser behaviour to expect

- **Agent Window**: `chrome.windows.create` works everywhere. Arc shows the window as a
  separate Arc window outside Spaces; Dia opens a plain window.
- **Debugger banner**: Chromium shows "BrowserControl started debugging this browser" while a
  tab is attached. The extension attaches lazily and detaches on session stop / tab return.
  Brave and Edge show the same bar; Whale shows a localized one.
- **Headless/automation**: branded Google Chrome 137+ ignores `--load-extension`. For CI use
  Chrome for Testing, Chromium, or Playwright's Chromium (the e2e runner finds it automatically).
- **Incognito**: requires "Allow in Incognito" (Chrome/Edge/Brave/Whale) or "Allow in Private"
  wording; Arc/Dia expose it on the extension details page.
- **Policy-managed profiles** may block `chrome.debugger`. Reads still work (they use
  `chrome.scripting`); clicks fall back to DOM events and report `via: "dom"`.
