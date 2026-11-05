# Store listing — BrowserControl 1.0.0

## Chrome Web Store

**Name**: BrowserControl
**Summary (≤132)**: Let shell-capable AI agents drive this browser via the bctl CLI, in a separate Agent Window, with your existing logins.
**Category**: Developer Tools
**Language**: English (Korean listing below)

**Description**
BrowserControl connects AI coding agents (Claude Code, Codex, Cursor, Gemini CLI and any agent that can run shell commands) to the browser you already use. The agent runs the open-source `bctl` command-line tool on your computer; this extension executes its requests in a separate Agent Window so your own tabs are never touched unless you explicitly lend one.

What the agent can do: open pages, read an accessibility outline of the page, click, type, fill forms, select options, scroll, take screenshots, read console messages and network requests for debugging, and wait for page changes. Every controlled tab shows a BrowserControl badge with a Stop button that immediately blocks further actions.

Works with Chrome, Edge, Whale, Brave, Arc, Dia and other Chromium 125+ browsers. All communication stays on your machine (loopback WebSocket to the local `bctl` daemon). No account, no analytics, no remote servers.

Install the CLI and the agent skill from https://github.com/oswarld/BrowserControl.

**Single purpose**: Execute browser automation requests from the user's local `bctl` CLI in an isolated Agent Window.

**Permission justifications**
- `debugger`: dispatch trusted mouse/keyboard input, capture screenshots, read console and network events, and handle JavaScript dialogs on tabs the agent controls.
- `scripting` + host permission `<all_urls>`: read the page outline, text and HTML, and scroll on any site the user sends the agent to; the agent's target sites are not known in advance.
- `tabs`, `windows`: create and manage the Agent Window, list tabs, and move a user tab into/out of the Agent Window when the user lends it.
- `webNavigation`: detect page loads to re-apply the control badge.
- `storage`: keep the daemon port, label, and a random instance id.
- `alarms`: keep the service worker's local WebSocket alive.
- `cookies`: list cookie names (never values) so an agent can tell whether a site session exists.
- Remote code: none. Content scripts and the service worker are bundled; no code is fetched at runtime.

**Data usage**: The extension sends page content and screenshots only to the local `bctl` daemon on 127.0.0.1, which the user runs. Nothing is transmitted to the developer or third parties. No personal data is collected, sold, or used for unrelated purposes.

**Privacy policy** (host at GitHub, link it in the dashboard):
BrowserControl does not collect, store, or transmit personal data. Page content, screenshots and browser metadata are exchanged only with the user's local `bctl` process over the loopback interface and are never sent to the developer or any third party. Cookie values, passwords and tokens are never read.

## Whale Store (스토어 등록 정보)

**이름**: BrowserControl
**요약**: AI 에이전트가 bctl CLI로 내 브라우저를 별도의 에이전트 창에서 안전하게 조작하게 합니다.
**카테고리**: 개발자 도구

**설명**
BrowserControl은 Claude Code, Codex, Cursor, Gemini CLI 등 셸 명령을 실행할 수 있는 AI 에이전트를 지금 쓰고 있는 브라우저에 연결합니다. 에이전트는 내 컴퓨터에서 오픈소스 `bctl` 명령줄 도구를 실행하고, 이 확장은 그 요청을 별도의 **에이전트 창**에서 수행합니다. 내 탭은 명시적으로 빌려주지 않는 한 건드리지 않습니다.

가능한 작업: 페이지 열기, 접근성 개요 읽기, 클릭·입력·폼 채우기·옵션 선택·스크롤, 스크린샷, 콘솔/네트워크 디버깅, 페이지 변화 대기. 제어 중인 탭에는 BrowserControl 배지와 **중지** 버튼이 표시되어 언제든 에이전트를 멈출 수 있습니다.

Whale, Chrome, Edge, Brave, Arc, Dia 등 Chromium 125 이상 브라우저를 지원합니다. 모든 통신은 내 컴퓨터 안(127.0.0.1의 bctl 데몬)에서만 이루어지며 계정, 분석, 외부 서버가 없습니다.

CLI와 에이전트 스킬 설치: https://github.com/oswarld/BrowserControl

**개인정보 처리방침**: 개인정보를 수집·저장·전송하지 않습니다. 페이지 내용과 스크린샷은 사용자의 로컬 bctl 프로세스와만 교환되며 개발자나 제3자에게 전송되지 않습니다. 쿠키 값, 비밀번호, 토큰은 읽지 않습니다.

## Assets

- Ready: [128×128 extension icon](../packages/extension/public/icons/icon128.png).

Still needed:
- Screenshots 1280×800 (at least one): the Agent Window with the badge, the popup showing Connected, a terminal running `bctl snapshot`.
- Small promo tile 440×280 (Chrome, optional).
