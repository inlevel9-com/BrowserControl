// Control overlay shown in tabs that a bctl session controls. Lets the user stop the agent.
let host: HTMLElement | null = null;

function render(sessionId: string, controller?: { name: string; project?: string }): void {
  remove();
  host = document.createElement("bctl-control");
  host.style.cssText = "position:fixed;z-index:2147483647;top:8px;right:8px;pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });
  const who = controller?.name ? ` · ${controller.name}` : "";
  root.innerHTML = `
    <style>
      .b{pointer-events:auto;display:flex;gap:8px;align-items:center;background:#1e40afee;color:#fff;font:12px/1 -apple-system,system-ui,sans-serif;
         padding:6px 8px 6px 10px;border-radius:999px;box-shadow:0 2px 10px #0004;user-select:none}
      button{all:unset;cursor:pointer;background:#fff3;padding:3px 8px;border-radius:999px;font-weight:600}
      button:hover{background:#fff5}
    </style>
    <div class="b"><span>🤖 BrowserControl · ${sessionId}${who}</span><button id="stop" title="Stop the agent on this tab">Stop</button></div>`;
  root.getElementById("stop")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "bctl.user_interrupt", sessionId }).catch(() => {});
    const b = root.getElementById("stop") as HTMLButtonElement | null;
    if (b) {
      b.textContent = "Stopped";
      b.disabled = true;
    }
  });
  (document.documentElement ?? document).appendChild(host);
}
function remove(): void {
  host?.remove();
  host = null;
}

chrome.runtime.onMessage.addListener((msg: { type: string; sessionId?: string | null; controller?: { name: string; project?: string } }) => {
  if (msg.type !== "bctl.control") return;
  if (msg.sessionId) render(msg.sessionId, msg.controller);
  else remove();
});

chrome.runtime
  .sendMessage({ type: "bctl.whoami" })
  .then((r: { sessionId: string | null; controller?: { name: string; project?: string } }) => {
    if (r?.sessionId) render(r.sessionId, r.controller);
  })
  .catch(() => {});
export {};
