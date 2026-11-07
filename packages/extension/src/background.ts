// MV3 service worker: owns the daemon connection, handshake, heartbeat, tool dispatch,
// and session lifecycle events (window closed, user Stop button).
import {
  EXTENSION_CLIENT_ID,
  type Frame,
  type HandshakeParams,
  type HandshakeResult,
  isRequestFrame,
  isResponseFrame,
  PROTOCOL_VERSION,
  rpcError,
  type RpcError,
} from "@browser-control/protocol";
import { Cdp } from "./cdp";
import { DownloadTracker } from "./downloads";
import { detectBrowser, EXTENSION_VERSION, loadSettings, type Settings, wsUrlForPort } from "./identity";
import { Recorder } from "./recorder";
import { SessionManager } from "./sessions";
import { buildTools, ToolError } from "./tools";
import { WsTransport } from "./transport";

const HEARTBEAT_MS = 20_000;
const KEEPALIVE_ALARM = "bctl-keepalive";

const sessions = new SessionManager();
const cdp = new Cdp();
let settings: Settings | null = null;
let transport: WsTransport | null = null;
let handshake: HandshakeResult | null = null;
let handshakeError: string | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let browserMeta = { name: "chromium", version: "unknown" };
const inflight = new Map<string, AbortController>();

const downloads = new DownloadTracker(sessions, cdp);
const recorder = new Recorder(cdp, (event, payload) => emit(event, payload));

const tools = buildTools({
  sessions,
  cdp,
  downloads,
  recorder,
  notifyControlled(tabId, sessionId) {
    chrome.tabs.sendMessage(tabId, { type: "bctl.control", sessionId }).catch(() => {});
  },
});

// ---------------------------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------------------------

async function ensureTransport(): Promise<void> {
  settings = await loadSettings();
  browserMeta = await detectBrowser();
  const url = wsUrlForPort(settings.port);
  if (!transport) {
    transport = new WsTransport(url);
    transport.onOpen(() => void onOpen());
    transport.onMessage((f) => void onFrame(f));
    transport.onStateChange((s) => {
      if (s !== "connected") {
        handshake = null;
        stopHeartbeat();
        if (s === "disconnected") void onDisconnected();
      }
      void broadcastStatus();
    });
  } else transport.setUrl(url);
  if (settings.enabled) transport.connect();
  else transport.disconnect();
}

async function onOpen(): Promise<void> {
  if (!transport || !settings) return;
  handshakeError = null;
  const params: HandshakeParams = {
    client: EXTENSION_CLIENT_ID,
    version: EXTENSION_VERSION,
    protocol_version: PROTOCOL_VERSION,
    instance_id: settings.instanceId,
    browser: browserMeta,
    label: settings.label,
  };
  const id = `hs-${Math.random().toString(36).slice(2, 10)}`;
  const done = new Promise<void>((resolve) => {
    const off = transport!.onMessage((f) => {
      if (isResponseFrame(f) && f.id === id) {
        off();
        if ("error" in f) {
          handshakeError = `${f.error.code}: ${f.error.message}`;
          transport?.disconnect();
          setTimeout(() => transport?.connect(), 10_000);
        } else {
          handshake = f.result as HandshakeResult;
          startHeartbeat();
        }
        resolve();
      }
    });
    setTimeout(() => {
      off();
      resolve();
    }, 10_000);
  });
  transport.send({ id, method: "system.handshake", params });
  await done;
  void broadcastStatus();
}

async function onDisconnected(): Promise<void> {
  // Daemon gone: end every session and return borrowed tabs so the user keeps their pages.
  for (const id of Array.from(sessions.sessions.keys())) {
    await tools["tool.session_stop"]!({ session_id: id }).catch(() => {});
  }
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeat = setInterval(() => {
    try {
      transport?.send({ event: "system.heartbeat" });
    } catch {
      /* not connected */
    }
  }, HEARTBEAT_MS);
}
function stopHeartbeat(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

function emit(event: string, payload: unknown): void {
  try {
    transport?.send({ event, payload });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------

async function onFrame(f: Frame): Promise<void> {
  if (!isRequestFrame(f)) return;
  const { id, method, params } = f;
  if (method === "cancel") {
    const target = (params as { rpc_id?: string })?.rpc_id;
    if (target) inflight.get(target)?.abort();
    reply(id, { cancelled: !!target && inflight.has(target) });
    return;
  }
  if (method === "system.ping") {
    reply(id, { pong: true, ts: Date.now() });
    return;
  }
  const handler = tools[method];
  if (!handler) {
    replyError(id, rpcError("unknown_method", `extension does not implement ${method}`));
    return;
  }
  const ac = new AbortController();
  inflight.set(id, ac);
  try {
    const result = await handler(params);
    reply(id, result ?? {});
  } catch (e) {
    replyError(id, toRpcError(e));
  } finally {
    inflight.delete(id);
  }
}

function toRpcError(e: unknown): RpcError {
  if (e instanceof ToolError) return e.rpc;
  const msg = String((e as Error)?.message ?? e);
  if (/No tab with id|No window with id/i.test(msg)) return rpcError("not_found", msg, { reason: "tab_not_found" });
  if (/Cannot access|cannot be scripted|chrome:\/\/|Extensions gallery/i.test(msg)) return rpcError("unsupported", msg, { reason: "restricted_tab_url" });
  if (/Debugger is not attached|Another debugger|Cannot attach/i.test(msg)) return rpcError("cdp_failed", msg, { reason: "cdp_attach_failed" });
  return rpcError("internal", msg);
}

function reply(id: string, result: unknown): void {
  try {
    transport?.send({ id, result });
  } catch {
    /* lost connection */
  }
}
function replyError(id: string, error: RpcError): void {
  try {
    transport?.send({ id, error });
  } catch {
    /* lost connection */
  }
}

// ---------------------------------------------------------------------------------------------
// Browser events → daemon events
// ---------------------------------------------------------------------------------------------

chrome.windows.onRemoved.addListener((windowId) => {
  const s = sessions.byWindow(windowId);
  if (!s) return;
  sessions.sessions.delete(s.id);
  for (const tabId of s.borrowed.keys()) {
    // Borrowed tabs were closed with the window; nothing to return.
    cdp.forget(tabId);
  }
  emit("session.window_closed", { session_id: s.id, window_id: windowId });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  recorder.end(tabId, "tab_closed");
  cdp.forget(tabId);
  for (const s of sessions.sessions.values()) {
    s.borrowed.delete(tabId);
    if (s.activeTabId === tabId) s.activeTabId = null;
  }
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const s = sessions.byWindow(windowId);
  if (s) s.activeTabId = tabId;
});

// Re-mark controlled tabs after navigation so the overlay persists.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete") return;
  void (async () => {
    const s = await sessions.owner(tabId);
    if (s) chrome.tabs.sendMessage(tabId, { type: "bctl.control", sessionId: s.id, controller: s.controller }).catch(() => {});
    void tab;
  })();
});

cdp.onDialog((tabId, dialog) => {
  void (async () => {
    const s = await sessions.owner(tabId);
    if (s) emit("dialog.changed", { session_id: s.id, tab_id: tabId, dialog: dialog ?? null });
  })();
});

// Messages from popup / content script.
chrome.runtime.onMessage.addListener((msg: { type: string; [k: string]: unknown }, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "bctl.status":
        sendResponse(await statusSnapshot());
        break;
      case "bctl.settings.changed":
        await ensureTransport();
        sendResponse({ ok: true });
        break;
      case "bctl.reconnect":
        transport?.disconnect();
        await ensureTransport();
        sendResponse({ ok: true });
        break;
      case "bctl.user_interrupt": {
        const sid = String(msg.sessionId ?? "");
        emit("session.user_interrupt", { session_id: sid, tab_id: sender.tab?.id });
        sendResponse({ ok: true });
        break;
      }
      case "bctl.whoami": {
        const tabId = sender.tab?.id;
        const s = tabId !== undefined ? await sessions.owner(tabId) : undefined;
        sendResponse(s ? { sessionId: s.id, controller: s.controller } : { sessionId: null });
        break;
      }
      default:
        sendResponse({ error: "unknown message" });
    }
  })().catch((e) => sendResponse({ error: String(e) }));
  return true;
});

async function statusSnapshot() {
  const list = [];
  for (const s of sessions.sessions.values()) {
    const tabs = await sessions.controlledTabs(s);
    list.push({ id: s.id, windowId: s.windowId, tabs: tabs.length, borrowed: s.borrowed.size, controller: s.controller });
  }
  return {
    state: transport?.state ?? "disconnected",
    error: handshakeError ?? transport?.error ?? null,
    handshake,
    browser: browserMeta,
    settings,
    version: EXTENSION_VERSION,
    sessions: list,
  };
}

async function broadcastStatus(): Promise<void> {
  const snap = await statusSnapshot();
  chrome.runtime.sendMessage({ type: "bctl.status.push", status: snap }).catch(() => {});
  const color = snap.state === "connected" && handshake ? "#22c55e" : snap.state === "connecting" ? "#f59e0b" : "#9ca3af";
  const text = snap.state === "connected" && handshake ? (snap.sessions.length ? String(snap.sessions.length) : "●") : snap.state === "connecting" ? "…" : "";
  await chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  await chrome.action.setBadgeText({ text }).catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== KEEPALIVE_ALARM) return;
  if (!transport) void ensureTransport();
  else transport.poke();
  void broadcastStatus();
});
chrome.runtime.onStartup.addListener(() => void ensureTransport());
chrome.runtime.onInstalled.addListener(() => void ensureTransport());
void ensureTransport();
