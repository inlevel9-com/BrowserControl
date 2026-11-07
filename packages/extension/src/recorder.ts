// Tab recording through CDP Page.startScreencast. Frames are JPEGs pushed to the daemon as
// `record.frame` events; the daemon stores and encodes them.
import type { RecordFrameEvent } from "@browser-control/protocol";
import type { Cdp } from "./cdp";

interface Active {
  recordingId: string;
  sessionId: string;
  frames: number;
}

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
    this.active.set(tabId, { recordingId, sessionId, frames: 0 });
    try {
      await this.cdp.send(tabId, "Page.startScreencast", {
        format: "jpeg",
        quality: clamp(opts.quality ?? 70, 1, 100),
        maxWidth: clamp(opts.maxWidth ?? 1280, 64, 3840),
        maxHeight: clamp(opts.maxHeight ?? 800, 64, 2160),
        everyNthFrame: 1,
      });
    } catch (e) {
      this.active.delete(tabId);
      throw e;
    }
  }

  async stop(sessionId: string): Promise<{ recordingId: string; tabId: number; frames: number } | undefined> {
    const r = this.recordingFor(sessionId);
    if (!r) return undefined;
    this.active.delete(r.tabId);
    await this.cdp.sendAttached(r.tabId, "Page.stopScreencast").catch(() => {});
    return { recordingId: r.a.recordingId, tabId: r.tabId, frames: r.a.frames };
  }

  /** The recorded tab went away (closed, returned, debugger detached). */
  end(tabId: number, reason: string): void {
    const a = this.active.get(tabId);
    if (!a) return;
    this.active.delete(tabId);
    this.emit("record.ended", { session_id: a.sessionId, recording_id: a.recordingId, reason });
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
