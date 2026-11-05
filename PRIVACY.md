# BrowserControl Privacy Policy

Last updated November 5, 2026.

BrowserControl connects a Chromium browser to the `bctl` command-line tool and daemon you run on the same computer. It uses browser data to carry out your local automation commands and show the state of your sessions.

## Data BrowserControl handles

- **Browser and tab information.** BrowserControl handles the browser name and version, a random extension instance ID, and any browser label you enter. The tab-list command can return titles and URLs of open tabs in the connected profile, including tabs outside the Agent Window, so you can select a tab to lend to a session.
- **Page content and input.** Commands can read page text, HTML, links, accessible element descriptions and form values, take screenshots, create PDFs, and supply text or other input to a website. Page inspection and interaction run in the Agent Window or on tabs added to the session with the borrow command. Results may contain personal or sensitive information if it appears in the pages or diagnostics you choose to inspect.
- **Diagnostics and cookies.** The debugger can capture console messages and network activity from controlled tabs. A command can request a captured response body. An explicit cookie command reads Chrome cookie objects for the active tab URL or a specified domain. It returns cookie names and metadata, with cookie values omitted from that command’s output. An explicit `bctl eval` command can run an expression in a controlled page and return the result.

## Use and sharing

The extension sends requests and results over a loopback connection to the `bctl` daemon on your computer. BrowserControl has no developer-operated service that receives these data and includes no analytics or advertising. The publisher does not sell browser data or use it for creditworthiness or lending. BrowserControl uses information from Chrome APIs only to provide its browser automation features in accordance with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies#protecting_user_privacy), including its Limited Use requirements.

Actions you request on a website can transmit data to that website, just as if you performed them directly. If you give a separate AI agent or other tool access to `bctl`, that tool can receive command output and handle it under its own settings and privacy policy.

## Storage and controls

The extension stores the instance ID, browser label, daemon port, and enabled setting in local Chrome extension storage. Debugger events are buffered locally in memory. The daemon can write local operational logs. Screenshots and PDFs can be saved to files by CLI commands. You can delete these files and logs from your computer, and removing the extension clears its Chrome extension settings.

Use the **Stop** button on a controlled tab to interrupt the session, or end the session with `bctl session stop`. You can disable the extension’s daemon connection from its popup.

## Contact

For privacy questions, use the [BrowserControl support page](https://github.com/inlevel9-com/BrowserControl/issues). Avoid including sensitive page data in public issues.
