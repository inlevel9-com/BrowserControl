// Thin chrome.debugger wrapper: attach-once-per-tab, typed send, and per-tab buffers for
// console/network/dialog events. Attach is lazy: reads use chrome.scripting and never need it.
import type { ConsoleEntry, DialogInfo, NetworkEntry } from "@browser-control/protocol";

export const CDP_VERSION = "1.3";
const MAX_BUFFER = 500;

interface TabCapture {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  consoleSeq: number;
  networkSeq: number;
  pendingRequests: Map<string, { seq: number; start: number }>;
  dialog?: DialogInfo;
}

export class CdpError extends Error {
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "CdpError";
  }
}

export class Cdp {
  private attached = new Set<number>();
  private attaching = new Map<number, Promise<void>>();
  private captures = new Map<number, TabCapture>();
  private dialogListeners = new Set<(tabId: number, dialog: DialogInfo | undefined) => void>();
  private eventListeners = new Set<(tabId: number, method: string, params: Record<string, unknown> | undefined) => void>();

  constructor() {
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId === undefined) return;
      this.handleEvent(source.tabId, method, params as Record<string, unknown> | undefined);
    });
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) {
        this.attached.delete(source.tabId);
      }
    });
  }

  isAttached(tabId: number): boolean {
    return this.attached.has(tabId);
  }

  onDialog(l: (tabId: number, dialog: DialogInfo | undefined) => void): () => void {
    this.dialogListeners.add(l);
    return () => this.dialogListeners.delete(l);
  }

  /** Subscribe to every CDP event from attached tabs. Returns an unsubscribe function. */
  onEvent(l: (tabId: number, method: string, params: Record<string, unknown> | undefined) => void): () => void {
    this.eventListeners.add(l);
    return () => this.eventListeners.delete(l);
  }

  /** Resolve with the first event `method` on `tabId` matching `pred`, or null after `timeoutMs`. */
  waitForEvent(tabId: number, method: string, timeoutMs: number, pred: (p: Record<string, unknown> | undefined) => boolean = () => true): { promise: Promise<Record<string, unknown> | null>; cancel: () => void } {
    let off: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<Record<string, unknown> | null>((resolve) => {
      off = this.onEvent((id, m, p) => {
        if (id !== tabId || m !== method || !pred(p)) return;
        off();
        if (timer) clearTimeout(timer);
        resolve(p ?? {});
      });
      timer = setTimeout(() => {
        off();
        resolve(null);
      }, timeoutMs);
    });
    return {
      promise,
      cancel: () => {
        off();
        if (timer) clearTimeout(timer);
      },
    };
  }

  capture(tabId: number): TabCapture {
    let c = this.captures.get(tabId);
    if (!c) {
      c = { console: [], network: [], consoleSeq: 0, networkSeq: 0, pendingRequests: new Map() };
      this.captures.set(tabId, c);
    }
    return c;
  }

  pendingDialog(tabId: number): DialogInfo | undefined {
    return this.captures.get(tabId)?.dialog;
  }

  async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return;
    const inflight = this.attaching.get(tabId);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        await chrome.debugger.attach({ tabId }, CDP_VERSION);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (/already attached/i.test(msg)) {
          // Another DevTools/extension holds the tab. Treat as attached only if it is ours.
          throw new CdpError(`debugger already attached to tab ${tabId}: ${msg}`, "debugger_conflict");
        }
        if (/cannot attach|restricted|chrome:\/\/|not allowed|policy/i.test(msg)) throw new CdpError(msg, "cdp_attach_denied");
        throw new CdpError(msg, "cdp_attach_failed");
      }
      this.attached.add(tabId);
      this.capture(tabId);
      await Promise.allSettled([
        this.sendRaw(tabId, "Page.enable"),
        this.sendRaw(tabId, "Runtime.enable"),
        this.sendRaw(tabId, "Network.enable", { maxResourceBufferSize: 10 * 1024 * 1024, maxTotalBufferSize: 50 * 1024 * 1024 }),
        this.sendRaw(tabId, "Log.enable"),
      ]);
    })();
    this.attaching.set(tabId, p);
    try {
      await p;
    } finally {
      this.attaching.delete(tabId);
    }
  }

  async detach(tabId: number): Promise<void> {
    if (!this.attached.has(tabId)) return;
    this.attached.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      /* already gone */
    }
  }

  forget(tabId: number): void {
    this.attached.delete(tabId);
    this.captures.delete(tabId);
  }

  async send<T = unknown>(tabId: number, method: string, params?: object): Promise<T> {
    await this.attach(tabId);
    return this.sendRaw<T>(tabId, method, params);
  }

  /**
   * Input commands block inside CDP while a JavaScript dialog is open. For actions that can open
   * one (click, press, Enter after fill) resolve as soon as a dialog appears on that tab instead;
   * the command itself completes later, once the agent decides the dialog.
   */
  async sendOrDialog<T = unknown>(tabId: number, method: string, params?: object): Promise<{ result?: T; dialog?: DialogInfo }> {
    await this.attach(tabId);
    const existing = this.pendingDialog(tabId);
    if (existing) return { dialog: existing };
    return new Promise((resolve) => {
      let settled = false;
      const off = this.onDialog((id, dialog) => {
        if (id !== tabId || !dialog || settled) return;
        settled = true;
        off();
        resolve({ dialog });
      });
      this.sendRaw<T>(tabId, method, params).then(
        (result) => {
          if (settled) return;
          settled = true;
          off();
          resolve({ result });
        },
        (err) => {
          if (settled) return;
          settled = true;
          off();
          const d = this.pendingDialog(tabId);
          if (d) resolve({ dialog: d });
          else throw err;
        },
      );
    });
  }

  /** Send on an already-attached tab without trying to attach (used for acks from event handlers). */
  sendAttached<T = unknown>(tabId: number, method: string, params?: object): Promise<T> {
    return this.sendRaw<T>(tabId, method, params);
  }

  private async sendRaw<T = unknown>(tabId: number, method: string, params?: object): Promise<T> {
    try {
      return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/not attached|detached/i.test(msg)) this.attached.delete(tabId);
      throw new CdpError(`${method}: ${msg}`, "cdp_command_failed");
    }
  }

  private handleEvent(tabId: number, method: string, params?: Record<string, unknown>): void {
    for (const l of this.eventListeners) {
      try {
        l(tabId, method, params);
      } catch {
        /* listener errors never break capture */
      }
    }
    const c = this.capture(tabId);
    const now = Date.now();
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const args = (params?.args as Array<{ value?: unknown; description?: string; type?: string }>) ?? [];
        const text = args
          .map((a) => (a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : (a.description ?? a.type ?? "")))
          .join(" ");
        const frame = (params?.stackTrace as { callFrames?: Array<{ url?: string; lineNumber?: number }> })?.callFrames?.[0];
        pushBounded(c.console, { seq: ++c.consoleSeq, ts: now, level: String(params?.type ?? "log"), text: clip(text), url: frame?.url, line: frame?.lineNumber });
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = params?.exceptionDetails as { text?: string; exception?: { description?: string }; url?: string; lineNumber?: number } | undefined;
        pushBounded(c.console, { seq: ++c.consoleSeq, ts: now, level: "error", text: clip(d?.exception?.description ?? d?.text ?? "exception"), url: d?.url, line: d?.lineNumber });
        break;
      }
      case "Log.entryAdded": {
        const e = params?.entry as { level?: string; text?: string; url?: string; lineNumber?: number; source?: string } | undefined;
        if (e) pushBounded(c.console, { seq: ++c.consoleSeq, ts: now, level: `${e.source ?? "log"}:${e.level ?? "info"}`, text: clip(e.text ?? ""), url: e.url, line: e.lineNumber });
        break;
      }
      case "Network.requestWillBeSent": {
        const req = params?.request as { url?: string; method?: string } | undefined;
        const id = String(params?.requestId);
        const seq = ++c.networkSeq;
        c.pendingRequests.set(id, { seq, start: now });
        pushBounded(c.network, { seq, ts: now, request_id: id, method: req?.method ?? "GET", url: clip(req?.url ?? "", 2048), resource_type: params?.type as string | undefined });
        break;
      }
      case "Network.responseReceived": {
        const id = String(params?.requestId);
        const resp = params?.response as { status?: number; mimeType?: string } | undefined;
        const entry = c.network.find((e) => e.request_id === id);
        if (entry) {
          entry.status = resp?.status;
          entry.mime = resp?.mimeType;
        }
        break;
      }
      case "Network.loadingFinished":
      case "Network.loadingFailed": {
        const id = String(params?.requestId);
        const entry = c.network.find((e) => e.request_id === id);
        const p = c.pendingRequests.get(id);
        if (entry && p) entry.duration_ms = now - p.start;
        if (entry && method === "Network.loadingFailed") entry.failed = String(params?.errorText ?? "failed");
        c.pendingRequests.delete(id);
        break;
      }
      case "Page.javascriptDialogOpening": {
        c.dialog = {
          tab_id: tabId,
          type: (params?.type as DialogInfo["type"]) ?? "alert",
          message: clip(String(params?.message ?? "")),
          default_prompt: params?.defaultPrompt as string | undefined,
          url: params?.url as string | undefined,
          opened_at: now,
        };
        for (const l of this.dialogListeners) l(tabId, c.dialog);
        break;
      }
      case "Page.javascriptDialogClosed": {
        c.dialog = undefined;
        for (const l of this.dialogListeners) l(tabId, undefined);
        break;
      }
      default:
        break;
    }
  }
}

function pushBounded<T>(arr: T[], v: T): void {
  arr.push(v);
  if (arr.length > MAX_BUFFER) arr.splice(0, arr.length - MAX_BUFFER);
}
function clip(s: string, n = 4096): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
