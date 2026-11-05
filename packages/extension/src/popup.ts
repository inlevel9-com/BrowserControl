// Popup: connection state, port/label settings, instance id, sessions.
type Status = {
  state: string;
  error: string | null;
  handshake: { server: string; version: string; process?: { name: string; browser?: string } } | null;
  browser: { name: string; version: string; detected_by?: string };
  settings: { instanceId: string; label: string; port: number; enabled: boolean } | null;
  version: string;
  sessions: Array<{ id: string; windowId: number; tabs: number; borrowed: number; controller?: { name: string; project?: string } }>;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function render(s: Status): void {
  const dot = $("dot");
  dot.className = `dot ${s.state === "connected" && s.handshake ? "connected" : s.state}`;
  $("state").textContent = s.state === "connected" && s.handshake ? `connected · v${s.version}` : s.state === "connected" ? "handshaking…" : s.state;
  $("enabled").toggleAttribute("checked", !!s.settings?.enabled);
  ($("enabled") as HTMLInputElement).checked = !!s.settings?.enabled;
  if (document.activeElement !== $("port")) ($("port") as HTMLInputElement).value = String(s.settings?.port ?? "");
  if (document.activeElement !== $("label")) ($("label") as HTMLInputElement).value = s.settings?.label ?? "";
  const procName = s.handshake?.process?.browser ?? s.handshake?.process?.name;
  $("browser").textContent = `${procName ? `${procName} (via daemon)` : s.browser.name} · Chromium ${s.browser.version}`;
  $("instance").textContent = s.settings?.instanceId ?? "";
  $("daemon").textContent = s.handshake ? `${s.handshake.server} v${s.handshake.version} on :${s.settings?.port}` : (s.error ?? `not connected (port ${s.settings?.port})`);
  const ul = $("sessions");
  ul.innerHTML = "";
  if (!s.sessions.length) ul.innerHTML = '<li class="muted">none</li>';
  for (const x of s.sessions) {
    const li = document.createElement("li");
    li.textContent = `${x.id} · ${x.tabs} tab(s)${x.borrowed ? `, ${x.borrowed} borrowed` : ""}${x.controller ? ` · ${x.controller.name}` : ""}`;
    ul.appendChild(li);
  }
  $("hint").textContent = s.state !== "connected" ? "Start the daemon: `bctl daemon start` (or any bctl command)." : "";
}

async function refresh(): Promise<void> {
  const s = (await chrome.runtime.sendMessage({ type: "bctl.status" })) as Status;
  if (s) render(s);
}

$("enabled").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ enabled: (e.target as HTMLInputElement).checked });
  await chrome.runtime.sendMessage({ type: "bctl.settings.changed" });
  setTimeout(refresh, 300);
});
$("savePort").addEventListener("click", async () => {
  const port = Number(($("port") as HTMLInputElement).value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  await chrome.storage.local.set({ port });
  await chrome.runtime.sendMessage({ type: "bctl.settings.changed" });
  setTimeout(refresh, 500);
});
$("saveLabel").addEventListener("click", async () => {
  const label = ($("label") as HTMLInputElement).value.trim();
  await chrome.storage.local.set({ label });
  await chrome.runtime.sendMessage({ type: "bctl.reconnect" });
  setTimeout(refresh, 800);
});
$("instance").addEventListener("click", () => navigator.clipboard?.writeText($("instance").textContent ?? ""));

chrome.runtime.onMessage.addListener((msg: { type: string; status?: Status }) => {
  if (msg.type === "bctl.status.push" && msg.status) render(msg.status);
});
void refresh();
setInterval(refresh, 2000);
export {};
