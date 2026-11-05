// Session registry: each session owns one Agent Window plus any explicitly borrowed user tabs.
import type { ControllerInfo } from "@browser-control/protocol";

export interface BorrowRecord {
  fromWindowId: number;
  fromIndex: number;
  wasActive: boolean;
}

export interface Session {
  id: string;
  windowId: number;
  activeTabId: number | null;
  borrowed: Map<number, BorrowRecord>;
  createdAt: number;
  controller?: ControllerInfo;
  incognito: boolean;
}

export class SessionManager {
  readonly sessions = new Map<string, Session>();

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  byWindow(windowId: number): Session | undefined {
    for (const s of this.sessions.values()) if (s.windowId === windowId) return s;
    return undefined;
  }

  /** Session that controls a tab: tab lives in its Agent Window or is borrowed by it. */
  async owner(tabId: number): Promise<Session | undefined> {
    for (const s of this.sessions.values()) if (s.borrowed.has(tabId)) return s;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId !== undefined) return this.byWindow(tab.windowId);
    } catch {
      /* gone */
    }
    return undefined;
  }

  async create(opts: { id: string; focused?: boolean; width?: number; height?: number; incognito?: boolean; controller?: ControllerInfo }): Promise<Session> {
    if (this.sessions.has(opts.id)) throw new Error(`session ${opts.id} already exists`);
    if (opts.incognito && !(await chrome.extension.isAllowedIncognitoAccess())) {
      throw new Error("incognito access is not allowed for this extension; enable it in the browser's extension settings");
    }
    const win = await chrome.windows.create({
      url: "about:blank",
      focused: opts.focused ?? false,
      type: "normal",
      incognito: opts.incognito ?? false,
      ...(opts.width ? { width: opts.width } : {}),
      ...(opts.height ? { height: opts.height } : {}),
    });
    if (!win?.id) throw new Error("chrome.windows.create returned no window");
    let tabId = win.tabs?.[0]?.id ?? null;
    if (tabId == null) {
      const tabs = await chrome.tabs.query({ windowId: win.id });
      tabId = tabs[0]?.id ?? null;
    }
    const s: Session = {
      id: opts.id,
      windowId: win.id,
      activeTabId: tabId,
      borrowed: new Map(),
      createdAt: Date.now(),
      controller: opts.controller,
      incognito: opts.incognito ?? false,
    };
    this.sessions.set(opts.id, s);
    return s;
  }

  /** Returns borrowed tabs, closes the Agent Window. */
  async destroy(id: string): Promise<{ returned: number[]; closed: number[] }> {
    const s = this.sessions.get(id);
    if (!s) return { returned: [], closed: [] };
    this.sessions.delete(id);
    const returned: number[] = [];
    for (const tabId of Array.from(s.borrowed.keys())) {
      try {
        await this.returnTab(s, tabId);
        returned.push(tabId);
      } catch {
        /* tab gone */
      }
    }
    const closed: number[] = [];
    try {
      const tabs = await chrome.tabs.query({ windowId: s.windowId });
      for (const t of tabs) if (t.id !== undefined) closed.push(t.id);
      await chrome.windows.remove(s.windowId);
    } catch {
      /* window already closed */
    }
    return { returned, closed };
  }

  async borrowTab(s: Session, tabId: number): Promise<BorrowRecord & { tab: chrome.tabs.Tab }> {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId === s.windowId) throw new Error("tab is already in the Agent Window");
    if (this.byWindow(tab.windowId!)) throw new Error("tab belongs to another session's Agent Window");
    for (const other of this.sessions.values()) if (other.borrowed.has(tabId)) throw new Error(`tab ${tabId} is borrowed by session ${other.id}`);
    if (!!tab.incognito !== s.incognito) throw new Error("incognito mismatch between tab and session");
    const rec: BorrowRecord = { fromWindowId: tab.windowId!, fromIndex: tab.index, wasActive: !!tab.active };
    await chrome.tabs.move(tabId, { windowId: s.windowId, index: -1 });
    await chrome.tabs.update(tabId, { active: true });
    s.borrowed.set(tabId, rec);
    s.activeTabId = tabId;
    return { ...rec, tab };
  }

  async returnTab(s: Session, tabId: number): Promise<number> {
    const rec = s.borrowed.get(tabId);
    if (!rec) throw new Error(`tab ${tabId} is not borrowed by session ${s.id}`);
    s.borrowed.delete(tabId);
    let targetWindow = rec.fromWindowId;
    try {
      await chrome.windows.get(targetWindow);
    } catch {
      const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
      const candidate = wins.find((w) => w.id !== undefined && !this.byWindow(w.id) && w.incognito === s.incognito);
      if (candidate?.id !== undefined) targetWindow = candidate.id;
      else {
        const created = await chrome.windows.create({ tabId, focused: false, incognito: s.incognito });
        if (s.activeTabId === tabId) s.activeTabId = null;
        return created?.id ?? -1;
      }
    }
    await chrome.tabs.move(tabId, { windowId: targetWindow, index: rec.fromIndex });
    if (rec.wasActive) await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    if (s.activeTabId === tabId) s.activeTabId = null;
    return targetWindow;
  }

  async controlledTabs(s: Session): Promise<chrome.tabs.Tab[]> {
    const inWindow = await chrome.tabs.query({ windowId: s.windowId }).catch(() => [] as chrome.tabs.Tab[]);
    return inWindow;
  }

  /** Resolve the tab a tool should act on. */
  async resolveTab(s: Session, tabId?: number): Promise<chrome.tabs.Tab> {
    if (tabId !== undefined) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) throw new TabError("not_found", `tab ${tabId} not found`, "tab_not_found");
      if (tab.windowId !== s.windowId && !s.borrowed.has(tabId)) {
        throw new TabError("permission_denied", `tab ${tabId} is not controlled by session ${s.id}; borrow it first`, "tab_not_controlled");
      }
      return tab;
    }
    if (s.activeTabId != null) {
      const tab = await chrome.tabs.get(s.activeTabId).catch(() => null);
      if (tab && (tab.windowId === s.windowId || s.borrowed.has(tab.id!))) return tab;
    }
    const tabs = await chrome.tabs.query({ windowId: s.windowId, active: true }).catch(() => [] as chrome.tabs.Tab[]);
    const tab = tabs[0];
    if (!tab?.id) throw new TabError("not_found", `session ${s.id} has no active tab`, "no_active_tab");
    s.activeTabId = tab.id;
    return tab;
  }
}

export class TabError extends Error {
  constructor(
    readonly code: "not_found" | "permission_denied" | "unsupported",
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}

export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /^(chrome|edge|whale|brave|arc|dia|about|devtools|view-source|chrome-extension|chrome-untrusted):/i.test(url) && url !== "about:blank";
}
