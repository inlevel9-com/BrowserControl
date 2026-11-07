// Tab recording through CDP Page.startScreencast. Frames are JPEGs pushed to the daemon as
// `record.frame` events; the daemon stores and encodes them.
import type { RecordFrameEvent } from "@browser-control/protocol";
import type { Cdp } from "./cdp";

interface Active {
  recordingId: string;
  sessionId: string;
  frames: number;
  lastFrameAt: number;
  quality: number;
  maxWidth: number;
  maxHeight: number;
  poll?: ReturnType<typeof setInterval>;
  capturing?: boolean;
}

// Screencast frames only come while the window is painting. A window behind others (or a
// background window on some builds) may never paint, so when no frame has arrived for a while the
// recorder captures one itself; Page.captureScreenshot works for hidden windows too.
declare const __BCTL_FORCE_FALLBACKS__: boolean;
const FORCE_FALLBACKS = typeof __BCTL_FORCE_FALLBACKS__ === "boolean" && __BCTL_FORCE_FALLBACKS__;
const POLL_MS = 100;
const STALE_MS = 250;

export class Recorder {
  private active = new Map<number, Active>();

  constructor(
    private readonly cdp: Cdp,
    private readonly emit: (event: string, payload: unknown) => void,
  ) {
    cdp.onEvent((tabId, method, params) => {
      if (method !== "Page.screencastFrame") return;
      void cdp.sendAttached(tabId, "Page.screencastFrameAck", { sessionId: params?.sessionId }).catch(() => {});
      const a = this.active.get(tabId);
      if (!a) return;
      a.frames++;
      a.lastFrameAt = Date.now();
      const md = (params?.metadata ?? {}) as { timestamp?: number; deviceWidth?: number; deviceHeight?: number };
      const frame: RecordFrameEvent = {
        session_id: a.sessionId,
        recording_id: a.recordingId,
        data: String(params?.data ?? ""),
        ts: md.timestamp ? Math.round(md.timestamp * 1000) : Date.now(),
        ...(md.deviceWidth ? { width: Math.round(md.deviceWidth) } : {}),
        ...(md.deviceHeight ? { height: Math.round(md.deviceHeight) } : {}),
      };
      this.emit("record.frame", frame);
    });
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) this.end(source.tabId, "debugger_detached");
    });
  }

  recordingFor(sessionId: string): { tabId: number; a: Active } | undefined {
    for (const [tabId, a] of this.active) if (a.sessionId === sessionId) return { tabId, a };
    return undefined;
  }

  async start(tabId: number, sessionId: string, recordingId: string, opts: { quality?: number; maxWidth?: number; maxHeight?: number }): Promise<void> {
    const existing = this.recordingFor(sessionId);
    if (existing) throw new Error(`session ${sessionId} is already recording (${existing.a.recordingId}); stop it first`);
    const a: Active = {
      recordingId,
      sessionId,
      frames: 0,
      lastFrameAt: 0,
      quality: clamp(opts.quality ?? 70, 1, 100),
      maxWidth: clamp(opts.maxWidth ?? 1280, 64, 3840),
      maxHeight: clamp(opts.maxHeight ?? 800, 64, 2160),
    };
    this.active.set(tabId, a);
    try {
      if (FORCE_FALLBACKS) await this.cdp.attach(tabId);
      else await this.cdp.send(tabId, "Page.startScreencast", { format: "jpeg", quality: a.quality, maxWidth: a.maxWidth, maxHeight: a.maxHeight, everyNthFrame: 1 });
    } catch (e) {
      this.active.delete(tabId);
      throw e;
    }
    a.lastFrameAt = Date.now();
    a.poll = setInterval(() => void this.fillGap(tabId, a), POLL_MS);
  }

  /** Capture a frame directly when the screencast has gone quiet. */
  private async fillGap(tabId: number, a: Active): Promise<void> {
    if (this.active.get(tabId) !== a || a.capturing || Date.now() - a.lastFrameAt < STALE_MS) return;
    a.capturing = true;
    try {
      const m = await this.cdp.sendAttached<{ cssLayoutViewport?: { clientWidth: number; clientHeight: number } }>(tabId, "Page.getLayoutMetrics");
      const w = m.cssLayoutViewport?.clientWidth ?? 0;
      const h = m.cssLayoutViewport?.clientHeight ?? 0;
      const scale = w && h ? Math.min(1, a.maxWidth / w, a.maxHeight / h) : 1;
      const r = await this.cdp.sendAttached<{ data: string }>(tabId, "Page.captureScreenshot", {
        format: "jpeg",
        quality: a.quality,
        fromSurface: true,
        ...(w && h ? { clip: { x: 0, y: 0, width: w, height: h, scale } } : {}),
      });
      if (this.active.get(tabId) !== a || !r.data) return;
      a.frames++;
      a.lastFrameAt = Date.now();
      const frame: RecordFrameEvent = { session_id: a.sessionId, recording_id: a.recordingId, data: r.data, ts: a.lastFrameAt };
      this.emit("record.frame", frame);
    } catch {
      /* tab busy or gone; the next tick retries */
    } finally {
      a.capturing = false;
    }
  }

  async stop(sessionId: string): Promise<{ recordingId: string; tabId: number; frames: number } | undefined> {
    const r = this.recordingFor(sessionId);
    if (!r) return undefined;
    this.active.delete(r.tabId);
    if (r.a.poll) clearInterval(r.a.poll);
    await this.cdp.sendAttached(r.tabId, "Page.stopScreencast").catch(() => {});
    return { recordingId: r.a.recordingId, tabId: r.tabId, frames: r.a.frames };
  }

  /** The recorded tab went away (closed, returned, debugger detached). */
  end(tabId: number, reason: string): void {
    const a = this.active.get(tabId);
    if (!a) return;
    this.active.delete(tabId);
    if (a.poll) clearInterval(a.poll);
    this.emit("record.ended", { session_id: a.sessionId, recording_id: a.recordingId, reason });
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
