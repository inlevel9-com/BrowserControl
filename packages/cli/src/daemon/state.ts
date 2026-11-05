// Daemon state: connected browsers, sessions, per-session queues, and tombstones for ended sessions.
import type { BrowserEntry, BrowserMeta, ControllerInfo, ProcessIdentity, SessionEntry } from "@browser-control/protocol";
import type { WebSocket } from "ws";

export interface BrowserClient {
  instanceId: string;
  label: string;
  browser: BrowserMeta;
  extensionVersion: string;
  protocolVersion: string;
  process?: ProcessIdentity;
  connectedAt: number;
  lastSeen: number;
  ws: WebSocket;
}

export interface DaemonSession {
  id: string;
  browserInstanceId: string;
  createdAt: number;
  lastActivityAt: number;
  agentWindowId?: number;
  activeTabId?: number;
  interrupted: boolean;
  controller?: ControllerInfo;
  /** Serialises tool calls for this session. */
  queue: Promise<unknown>;
}

export class DaemonState {
  readonly browsers = new Map<string, BrowserClient>();
  readonly sessions = new Map<string, DaemonSession>();
  /** session id → why it ended; consulted so the CLI gets a precise error after the fact. */
  readonly tombstones = new Map<string, { reason: string; at: number }>();

  browserEntry(b: BrowserClient): BrowserEntry {
    let sessions = 0;
    for (const s of this.sessions.values()) if (s.browserInstanceId === b.instanceId) sessions++;
    return {
      instance_id: b.instanceId,
      label: b.label,
      browser: b.browser,
      extension_version: b.extensionVersion,
      protocol_version: b.protocolVersion,
      process: b.process,
      connected_at: new Date(b.connectedAt).toISOString(),
      sessions,
    };
  }

  sessionEntry(s: DaemonSession): SessionEntry {
    const b = this.browsers.get(s.browserInstanceId);
    return {
      session_id: s.id,
      browser_instance_id: s.browserInstanceId,
      browser_name: b ? displayBrowserName(b) : "disconnected",
      created_at: new Date(s.createdAt).toISOString(),
      last_activity_at: new Date(s.lastActivityAt).toISOString(),
      agent_window_id: s.agentWindowId,
      active_tab_id: s.activeTabId,
      interrupted: s.interrupted || undefined,
      controller: s.controller,
    };
  }

  /** Resolve `--browser` by instance id, exact label, or vendor name when unique. */
  selectBrowser(selector?: string): { client: BrowserClient } | { error: string; code: "no_browser_connected" | "multiple_browsers_online" | "not_found" } {
    const all = Array.from(this.browsers.values());
    if (all.length === 0) return { error: "no browser extension is connected; open the BrowserControl popup and check it shows Connected", code: "no_browser_connected" };
    if (!selector) {
      if (all.length === 1) return { client: all[0]! };
      return {
        error: `${all.length} browsers are connected; choose one with --browser <id|label|name>: ${all.map((b) => `${b.instanceId}(${displayBrowserName(b)}${b.label ? `, "${b.label}"` : ""})`).join(", ")}`,
        code: "multiple_browsers_online",
      };
    }
    const sel = selector.trim().toLowerCase();
    const byId = all.find((b) => b.instanceId.toLowerCase() === sel);
    if (byId) return { client: byId };
    const byLabel = all.filter((b) => b.label.toLowerCase() === sel);
    if (byLabel.length === 1) return { client: byLabel[0]! };
    if (byLabel.length > 1) return { error: `label "${selector}" is not unique; use the instance id`, code: "multiple_browsers_online" };
    const byName = all.filter((b) => displayBrowserName(b).toLowerCase() === sel || b.browser.name.toLowerCase() === sel);
    if (byName.length === 1) return { client: byName[0]! };
    if (byName.length > 1) return { error: `${byName.length} "${selector}" browsers are connected; use the instance id or label`, code: "multiple_browsers_online" };
    return { error: `no connected browser matches "${selector}"; run \`bctl browsers\``, code: "not_found" };
  }

  newSessionId(): string {
    const alphabet = "abcdefghijkmnpqrstuvwxyz";
    for (;;) {
      let id = "";
      for (let i = 0; i < 4; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
      if (!this.sessions.has(id) && !this.tombstones.has(id)) return id;
    }
  }
}

export function displayBrowserName(b: BrowserClient): string {
  // Daemon-side process identity wins (it is the only way to name Arc/Dia); UA detection is the fallback.
  const vendor = b.process?.browser ?? b.browser.name;
  const pretty: Record<string, string> = {
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
  return pretty[vendor] ?? vendor;
}
