# Environment

## CLI missing

Check `bctl --version`. Install options, in order of preference:

```sh
npm install -g browser-control        # published package (bin: bctl)
# or from a checkout:
pnpm install && pnpm build && pnpm -F browser-control link --global
```

If the command is not on PATH for the agent process, use the absolute path or restart the agent.

## Daemon

Any `bctl` command auto-starts the daemon (`~/.bctl`, WebSocket on `127.0.0.1:52810`).
`BCTL_AUTO_START=0` disables that; then run `bctl daemon start` (detached) or
`bctl daemon start --foreground` inside a managed background task on hosts that reap child
processes. `bctl status --json` and `bctl doctor` show daemon, browsers, and skill state.
`bctl logs -n 100` prints the daemon log. Never delete `~/.bctl` to "fix" things; use
`bctl daemon stop` and `bctl daemon start`.

Settings: `BCTL_HOME` (state directory), `BCTL_PORT` (WebSocket port, must match the
extension popup), `BCTL_SESSION` (default session id), `BCTL_EXTENSION_IDS` (allow-list of
extension ids).

## No browser connected

The extension must be installed in the browser and show **Connected** in its popup:

1. Build it (`pnpm build`) or take `packages/extension/dist`.
2. In the browser open the extensions page (`chrome://extensions`, `edge://extensions`,
   `whale://extensions`, `brave://extensions`; Arc and Dia: `chrome://extensions` in the address
   bar), enable Developer mode, **Load unpacked**, choose the `dist` folder.
3. Open the popup. Set the daemon port if you changed it, optionally set a label such as
   `work-chrome`, and confirm the state is Connected.

Then `bctl browsers` lists it. Each browser profile gets its own instance id; a label makes
`--browser <label>` readable. The daemon names Arc and Dia from the connecting process, since
their user agent looks like Chrome.

## Remote agents

The CLI and daemon must run on the machine where the browser runs. Remote pairing is not part
of this version; run the agent on the same machine or over SSH to it.
