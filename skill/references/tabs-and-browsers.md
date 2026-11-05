# Tabs and browsers

## Choosing a browser

`bctl browsers --json` lists connected browsers with `instance_id`, `label`, the vendor
(`process.browser` when the daemon identified the process, else `browser.name`) and
Chromium version. Pass `--browser` on `session start`:

- instance id (always unique), a popup label the user set, or a vendor name
  (`chrome`, `edge`, `whale`, `brave`, `arc`, `dia`) when exactly one of that vendor is online.
- With more than one browser connected and no selector, `session start` fails with
  `multiple_browsers_online` and lists the choices. Never pick one silently if the user named a
  browser or profile; if the named one is missing, report it.

A browser profile is one extension instance. Opening another profile does not retarget an
existing session. After an extension reinstall the instance id changes; list again.

## Incognito

`bctl session start --incognito` opens the Agent Window in the browser's incognito session.
The extension must be allowed in incognito (browser setting). Incognito sessions cannot borrow
normal tabs and vice versa.

## Borrowing user tabs

```sh
bctl tab list --scope user
bctl tab borrow <tab-id>
# ... work ...
bctl tab return <tab-id>
```

- Borrowing moves the tab into the Agent Window and selects it; returning moves it back to its
  original window and index (or another normal window if the original closed).
- The borrowed tab keeps its page, logins, and unsaved state. Verify the expected account or
  page state before acting; do not assume.
- `tab close` is refused for borrowed tabs. Session stop returns every borrowed tab.
- Other sessions' Agent Windows are never listed; `--scope all` is this session's window plus
  user windows.

## Parallel sessions

Sessions in the same browser profile share cookies and site state. Two tasks logging into the
same site, or switching accounts, can overwrite each other. Before running tasks in parallel on
one browser, compare their target domains (`bctl session list --json`, then `tab list --scope
agent --session <id>` for each) and serialise overlapping ones.

## Tab ids and defaults

Commands act on the session's active tab unless `--tab <id>` is given. `tab new` with
`--background` returns a tab id to pass explicitly. Never invent tab ids.
