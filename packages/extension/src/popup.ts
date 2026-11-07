// Popup: connection state, browser identity, label/port settings, active agent sessions.
type Status = {
  state: string;
  error: string | null;
  handshake: { server: string; version: string; process?: { name: string; browser?: string } } | null;
  browser: { name: string; version: string; detected_by?: string };
  browserIcon?: string | null;
  settings: { instanceId: string; label: string; port: number; enabled: boolean } | null;
  version: string;
  sessions: Array<{ id: string; windowId: number; tabs: number; borrowed: number; controller?: { name: string; project?: string } }>;
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const PRETTY: Record<string, string> = {
  chrome: "Chrome",
  edge: "Edge",
  whale: "Whale",
  brave: "Brave",
  arc: "Arc",
  dia: "Dia",
  opera: "Opera",
  vivaldi: "Vivaldi",
  yandex: "Yandex",
  samsung: "Samsung Internet",
  chromium: "Chromium",
};

const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

function setPill(kind: "ok" | "warn" | "bad" | "off", text: string): void {
  $("pill").className = `pill ${kind}`;
  $("pillText").textContent = text;
}

function render(s: Status): void {
  const enabled = s.settings?.enabled !== false;
  const connected = s.state === "connected" && !!s.handshake;

  if (!enabled) setPill("off", "Paused");
  else if (connected) setPill("ok", "Connected");
  else if (s.state === "connecting" || s.state === "connected") setPill("warn", "Connecting");
  else setPill("bad", "Offline");

  $("offline").classList.toggle("hidden", !enabled || connected || s.state === "connecting" || s.state === "connected");
  $("offlineDetail").textContent = s.error ?? `nothing answered on 127.0.0.1:${s.settings?.port ?? ""}`;
  $("disabled").classList.toggle("hidden", enabled);

  const toggle = $<HTMLInputElement>("enabled");
  if (document.activeElement !== toggle) toggle.checked = enabled;

  const vendor = s.handshake?.process?.browser ?? s.browser.name;
  const name = PRETTY[vendor] ?? vendor;
  $("browserName").textContent = name;
  const glyph = $("glyph");
  const icon = s.browserIcon && s.browserIcon.startsWith("data:image/png;base64,") ? s.browserIcon : null;
  glyph.classList.toggle("has-icon", !!icon);
  if (icon) {
    let img = glyph.querySelector("img");
    if (!img) {
      img = document.createElement("img");
      img.alt = "";
      glyph.replaceChildren(img);
    }
    if (img.src !== icon) img.src = icon;
  } else glyph.textContent = name.slice(0, 1).toUpperCase();
  $("browserVer").textContent = `Chromium ${s.browser.version}`;
  $("sub").textContent = s.settings?.label ? `“${s.settings.label}”` : "AI agents in your browser";

  const label = $<HTMLInputElement>("label");
  if (document.activeElement !== label) label.value = s.settings?.label ?? "";
  const port = $<HTMLInputElement>("port");
  if (document.activeElement !== port) port.value = String(s.settings?.port ?? "");
  $("instance").textContent = s.settings?.instanceId ?? "–";
  $("daemon").textContent = connected ? `v${s.handshake!.version} · port ${s.settings?.port}` : `port ${s.settings?.port ?? "–"}`;
  $("extVersion").textContent = `v${s.version}`;

  const selector = s.settings?.label || s.settings?.instanceId || "<id>";
  const cmd = `bctl session start --browser ${/\s/.test(selector) ? JSON.stringify(selector) : selector}`;
  $("cmd").textContent = cmd;
  $("copyCmd").dataset.copy = cmd;
  $("copyInstance").dataset.copy = s.settings?.instanceId ?? "";

  // No daemon, no sessions: keep the popup short and focused on the fix.
  $("sessionsCard").classList.toggle("hidden", !connected && s.sessions.length === 0);
  $("count").textContent = String(s.sessions.length);
  const list = $("sessions");
  list.replaceChildren();
  if (!s.sessions.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = connected ? "No agent is using this browser right now." : "Sessions appear here once an agent connects.";
    list.appendChild(empty);
  }
  for (const x of s.sessions) {
    const row = document.createElement("div");
    row.className = "session";
    const sid = document.createElement("span");
    sid.className = "sid";
    sid.textContent = x.id;
    const who = document.createElement("div");
    who.className = "who";
    const b = document.createElement("b");
    b.textContent = x.controller?.name || "Agent";
    const small = document.createElement("small");
    const parts = [`${x.tabs} tab${x.tabs === 1 ? "" : "s"}`];
    if (x.borrowed) parts.push(`${x.borrowed} borrowed`);
    if (x.controller?.project) parts.push(x.controller.project);
    small.textContent = parts.join(" · ");
    who.append(b, small);
    row.append(sid, who);
    list.appendChild(row);
  }
}

async function refresh(): Promise<void> {
  const s = (await chrome.runtime.sendMessage({ type: "bctl.status" })) as Status;
  if (s) render(s);
  // Animate the switch only for changes after the first paint.
  requestAnimationFrame(() => document.body.classList.remove("no-anim"));
}

function flash(id: string): void {
  const el = $(id);
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 1400);
}

// Copy buttons
for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("button.copy"))) {
  btn.innerHTML = COPY_ICON;
  btn.addEventListener("click", async () => {
    const value = btn.dataset.copy ?? "";
    if (!value) return;
    await navigator.clipboard?.writeText(value).catch(() => undefined);
    btn.innerHTML = CHECK_ICON;
    btn.classList.add("done");
    setTimeout(() => {
      btn.innerHTML = COPY_ICON;
      btn.classList.remove("done");
    }, 1200);
  });
}

$<HTMLInputElement>("enabled").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ enabled: (e.target as HTMLInputElement).checked });
  await chrome.runtime.sendMessage({ type: "bctl.settings.changed" });
  setTimeout(refresh, 300);
});

async function saveLabel(): Promise<void> {
  const input = $<HTMLInputElement>("label");
  const label = input.value.trim().slice(0, 64);
  const { label: current } = await chrome.storage.local.get("label");
  if ((current ?? "") === label) return;
  await chrome.storage.local.set({ label });
  await chrome.runtime.sendMessage({ type: "bctl.reconnect" });
  flash("labelSaved");
  setTimeout(refresh, 800);
}
$<HTMLInputElement>("label").addEventListener("change", () => void saveLabel());
$<HTMLInputElement>("label").addEventListener("keydown", (e) => {
  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
});

async function savePort(): Promise<void> {
  const input = $<HTMLInputElement>("port");
  const port = Number(input.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    input.setCustomValidity("1–65535");
    input.reportValidity();
    return;
  }
  input.setCustomValidity("");
  await chrome.storage.local.set({ port });
  await chrome.runtime.sendMessage({ type: "bctl.settings.changed" });
  flash("portSaved");
  setTimeout(refresh, 500);
}
$<HTMLInputElement>("port").addEventListener("change", () => void savePort());
$<HTMLInputElement>("port").addEventListener("keydown", (e) => {
  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
});

chrome.runtime.onMessage.addListener((msg: { type: string; status?: Status }) => {
  if (msg.type === "bctl.status.push" && msg.status) render(msg.status);
});
void refresh();
setInterval(refresh, 2000);
export {};
