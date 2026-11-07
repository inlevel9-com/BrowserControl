// Download tracking: which chrome.downloads items belong to which session. Only downloads that a
// session started (bctl download) or that a controlled tab triggered are ever reported, so an
// agent never sees the user's other downloads.
import type { DownloadInfo } from "@browser-control/protocol";
import type { Cdp } from "./cdp";
import type { SessionManager } from "./sessions";

const HINT_TTL_MS = 60_000;

export class DownloadTracker {
  private owner = new Map<number, string>();
  private hints: Array<{ tabId: number; url: string; ts: number }> = [];

  constructor(
    private readonly sessions: SessionManager,
    cdp: Cdp,
  ) {
    cdp.onEvent((tabId, method, params) => {
      if (method !== "Page.downloadWillBegin" && method !== "Browser.downloadWillBegin") return;
      const now = Date.now();
      this.hints = this.hints.filter((h) => now - h.ts < HINT_TTL_MS);
      this.hints.push({ tabId, url: String(params?.url ?? ""), ts: now });
    });
    if (chrome.downloads?.onCreated) {
      chrome.downloads.onCreated.addListener((item) => {
        void this.attribute(item).then((owned) => {
          // The CDP hint can arrive just after onCreated; try once more.
          if (!owned) setTimeout(() => void this.attribute(item), 500);
        });
      });
    }
  }

  /** Record that a session started this download itself. */
  claim(downloadId: number, sessionId: string): void {
    this.owner.set(downloadId, sessionId);
  }

  ownerOf(downloadId: number): string | undefined {
    return this.owner.get(downloadId);
  }

  private async attribute(item: chrome.downloads.DownloadItem): Promise<boolean> {
    if (this.owner.has(item.id)) return true;
    // Downloads this extension started are claimed by the session that asked (see claim()).
    if (item.byExtensionId && item.byExtensionId === chrome.runtime.id) return true;
    const urls = new Set([item.url, item.finalUrl].filter(Boolean));
    const now = Date.now();
    for (let i = this.hints.length - 1; i >= 0; i--) {
      const h = this.hints[i]!;
      if (!urls.has(h.url) || now - h.ts > HINT_TTL_MS) continue;
      const s = await this.sessions.owner(h.tabId);
      if (!s) continue;
      // Each page-triggered download consumes its own hint.
      this.hints.splice(this.hints.indexOf(h), 1);
      if (!this.owner.has(item.id)) this.owner.set(item.id, s.id);
      return true;
    }
    if (item.referrer) {
      for (const s of this.sessions.sessions.values()) {
        const tabs = await this.sessions.controlledTabs(s);
        if (tabs.some((t) => t.url === item.referrer)) {
          if (!this.owner.has(item.id)) this.owner.set(item.id, s.id);
          return true;
        }
      }
    }
    return false;
  }

  async info(downloadId: number): Promise<DownloadInfo | undefined> {
    const [item] = await chrome.downloads.search({ id: downloadId });
    return item ? toInfo(item) : undefined;
  }

  async list(sessionId: string): Promise<DownloadInfo[]> {
    const out: DownloadInfo[] = [];
    for (const [id, sid] of this.owner) {
      if (sid !== sessionId) continue;
      const info = await this.info(id);
      if (info) out.push(info);
    }
    return out.sort((a, b) => a.started_at.localeCompare(b.started_at));
  }

  /**
   * Wait for a session download to finish. With an id, that download; otherwise the newest one
   * started at/after `sinceMs`, waiting for one to appear if none has yet.
   */
  async wait(sessionId: string, opts: { downloadId?: number; sinceMs?: number; timeoutMs: number }): Promise<{ waited?: DownloadInfo; timedOut: boolean }> {
    const deadline = Date.now() + opts.timeoutMs;
    let last: DownloadInfo | undefined;
    while (Date.now() <= deadline) {
      let cand: DownloadInfo | undefined;
      if (opts.downloadId !== undefined) cand = await this.info(opts.downloadId);
      else {
        const since = opts.sinceMs ?? 0;
        const all = (await this.list(sessionId)).filter((d) => Date.parse(d.started_at) >= since - 1000);
        cand = all[all.length - 1];
      }
      last = cand ?? last;
      if (cand && cand.state !== "in_progress" && cand.filename) return { waited: cand, timedOut: false };
      await new Promise((r) => setTimeout(r, 200));
    }
    return { waited: last, timedOut: true };
  }
}

function toInfo(item: chrome.downloads.DownloadItem): DownloadInfo {
  const filename = item.filename ?? "";
  return {
    download_id: item.id,
    url: item.finalUrl || item.url,
    filename,
    basename: filename.split(/[\\/]/).pop() ?? "",
    ...(item.mime ? { mime: item.mime } : {}),
    state: item.state as DownloadInfo["state"],
    ...(item.error ? { error: item.error } : {}),
    bytes_received: item.bytesReceived,
    total_bytes: item.totalBytes,
    started_at: item.startTime,
    ...(item.endTime ? { ended_at: item.endTime } : {}),
  };
}
