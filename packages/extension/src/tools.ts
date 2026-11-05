// Tool dispatcher: maps `tool.*` methods to browser operations. Reads go through
// chrome.scripting (page-agent); trusted input and captures go through CDP, with a DOM fallback.
import {
  type ActionResult,
  type CheckParams,
  type ClickParams,
  type ConsoleParams,
  type ConsoleResult,
  type CookiesParams,
  type CookiesResult,
  type DialogHandleParams,
  type DialogHandleResult,
  type DialogStatusResult,
  type EvaluateParams,
  type EvaluateResult,
  type FillParams,
  type FindParams,
  type FindResult,
  type GetHtmlParams,
  type GetHtmlResult,
  type GetTextParams,
  type GetTextResult,
  type HistoryParams,
  type NavigateParams,
  type NavigateResult,
  type NetworkParams,
  type NetworkResult,
  type PdfParams,
  type PdfResult,
  type PressParams,
  type RpcError,
  rpcError,
  type ScreenshotParams,
  type ScreenshotResult,
  type ScrollParams,
  type ScrollResult,
  type SelectParams,
  type SelectResult,
  type SessionScoped,
  type SnapshotParams,
  type SnapshotResult,
  type TabCreateParams,
  type TabCreateResult,
  type TabIdParams,
  type TabInfo,
  type TabListParams,
  type TabListResult,
  type TabScoped,
  type ToolSessionStartParams,
  type ToolSessionStartResult,
  type ToolSessionStopResult,
  type TypeParams,
  type WaitForElementParams,
  type WaitForElementResult,
  type WaitForNavigationParams,
  type WaitForNavigationResult,
  type WindowResizeParams,
} from "@browser-control/protocol";
import { Cdp, CdpError } from "./cdp";
import { parseKeyCombo } from "./keys";
import { pageAgent, type PageOp } from "./page-agent";
import { isRestrictedUrl, type Session, SessionManager, TabError } from "./sessions";

export class ToolError extends Error {
  constructor(readonly rpc: RpcError) {
    super(rpc.message);
  }
}
function fail(code: RpcError["code"], message: string, reason?: string, hint?: string): never {
  throw new ToolError(rpcError(code, message, { ...(reason ? { reason } : {}), ...(hint ? { hint } : {}) }));
}

export type ToolHandler = (params: unknown) => Promise<unknown>;

export interface ToolDeps {
  sessions: SessionManager;
  cdp: Cdp;
  notifyControlled: (tabId: number, sessionId: string | null) => void;
}

export function buildTools(deps: ToolDeps): Record<string, ToolHandler> {
  const { sessions, cdp } = deps;

  function session(p: SessionScoped): Session {
    const s = sessions.get(p?.session_id);
    if (!s) fail("not_found", `session ${p?.session_id} not found`, "session_not_found", "start a session with `bctl session start --json`");
    return s;
  }
  async function tab(p: TabScoped): Promise<{ s: Session; tab: chrome.tabs.Tab; tabId: number }> {
    const s = session(p);
    try {
      const t = await sessions.resolveTab(s, p.tab_id);
      return { s, tab: t, tabId: t.id! };
    } catch (e) {
      if (e instanceof TabError) fail(e.code, e.message, e.reason);
      throw e;
    }
  }
  function assertScriptable(t: chrome.tabs.Tab): void {
    if (isRestrictedUrl(t.url)) fail("unsupported", `tab ${t.id} is a restricted page (${t.url}); navigate to an http(s) page first`, "restricted_tab_url");
  }
  async function assertNoDialog(tabId: number): Promise<void> {
    const d = cdp.pendingDialog(tabId);
    if (d) fail("dialog_pending", `a ${d.type} dialog is open: ${JSON.stringify(d.message)}`, "dialog_pending", "decide it with `bctl dialog accept|dismiss` before continuing; never repeat the action");
  }

  // Run the page agent in the tab's isolated world.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function page<T = any>(t: chrome.tabs.Tab, op: PageOp, args: Record<string, unknown> = {}): Promise<T> {
    assertScriptable(t);
    await assertNoDialog(t.id!);
    let results: chrome.scripting.InjectionResult[];
    try {
      results = await withTimeout(
        chrome.scripting.executeScript({ target: { tabId: t.id! }, func: pageAgent, args: [op, args], world: "ISOLATED" }),
        15_000,
        `page script ${op}`,
      );
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/cannot access|restricted|chrome:\/\/|web store|extensions gallery/i.test(msg)) fail("unsupported", `cannot script tab ${t.id}: ${msg}`, "restricted_tab_url");
      if (/timed out/i.test(msg)) {
        const d = cdp.pendingDialog(t.id!);
        if (d) fail("dialog_pending", `a ${d.type} dialog is open: ${JSON.stringify(d.message)}`, "dialog_pending");
        fail("timeout", msg, "renderer_timeout", "the page may be hung or showing a native dialog; try `bctl dialog status` or reload");
      }
      fail("internal", `page script failed: ${msg}`, "script_failed");
    }
    const r = results[0]?.result as T;
    if (r && typeof r === "object" && "error" in (r as object)) fail("internal", String((r as unknown as { error: string }).error));
    return r;
  }

  async function resolveTarget(t: chrome.tabs.Tab, target: string) {
    const r = await page(t, "resolve", { target });
    if (!r.found) {
      const isRef = /^@?e\d+$/.test(target.trim());
      fail("not_found", `${isRef ? "ref" : "selector"} ${target} not found in tab ${t.id}`, isRef ? "ref_not_found" : "selector_not_found", isRef ? "refs expire on navigation; run `bctl snapshot` again" : "check the selector with `bctl snapshot` or `bctl find`");
    }
    return r as { x: number; y: number; width: number; height: number; visible: boolean; tag: string; description: string; disabled: boolean; covered: boolean };
  }

  async function navigatedTo(t: chrome.tabs.Tab): Promise<string | undefined> {
    const after = await chrome.tabs.get(t.id!).catch(() => null);
    return after?.url && after.url !== t.url ? after.url : undefined;
  }

  /** Returns true when a dialog opened mid-sequence (remaining events are skipped). */
  async function cdpMouse(tabId: number, x: number, y: number, opts: { button?: string; clickCount?: number; modifiers?: number }): Promise<boolean> {
    const button = opts.button ?? "left";
    const clickCount = opts.clickCount ?? 1;
    const modifiers = opts.modifiers ?? 0;
    if ((await cdp.sendOrDialog(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers })).dialog) return true;
    for (let i = 1; i <= clickCount; i++) {
      if ((await cdp.sendOrDialog(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i, modifiers })).dialog) return true;
      if ((await cdp.sendOrDialog(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i, modifiers })).dialog) return true;
    }
    return false;
  }

  async function pressKey(tabId: number, combo: string): Promise<boolean> {
    const { modifiers, spec } = parseKeyCombo(combo);
    const base = { modifiers, key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode };
    if ((await cdp.sendOrDialog(tabId, "Input.dispatchKeyEvent", { type: spec.text ? "keyDown" : "rawKeyDown", ...base, ...(spec.text ? { text: spec.text, unmodifiedText: spec.text } : {}) })).dialog) return true;
    if ((await cdp.sendOrDialog(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base })).dialog) return true;
    return false;
  }

  function cdpUnavailable(e: unknown): boolean {
    return e instanceof CdpError && (e.reason === "cdp_attach_denied" || e.reason === "cdp_attach_failed" || e.reason === "debugger_conflict");
  }

  async function waitTabComplete(tabId: number, timeoutMs: number, waitUntil: "none" | "load" | "domcontentloaded"): Promise<"complete" | "timeout"> {
    if (waitUntil === "none") return "complete";
    const deadline = Date.now() + timeoutMs;
    // Give the navigation a moment to flip status to "loading".
    await sleep(80);
    while (Date.now() < deadline) {
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (!t) fail("not_found", `tab ${tabId} closed during navigation`, "tab_closed");
      if (t.status === "complete") {
        if (waitUntil === "domcontentloaded") return "complete";
        return "complete";
      }
      if (cdp.pendingDialog(tabId)) return "complete";
      await sleep(100);
    }
    return "timeout";
  }

  const tools: Record<string, ToolHandler> = {
    // ----------------------------------------------------------------------- sessions
    async "tool.session_start"(raw) {
      const p = raw as ToolSessionStartParams;
      let s: Session;
      try {
        s = await sessions.create({ id: p.session_id, focused: p.focused, width: p.width, height: p.height, incognito: p.incognito, controller: p.controller });
      } catch (e) {
        fail("permission_denied", String((e as Error).message), "window_create_failed");
      }
      if (s.activeTabId != null) deps.notifyControlled(s.activeTabId, s.id);
      return { agent_window_id: s.windowId, active_tab_id: s.activeTabId ?? -1 } satisfies ToolSessionStartResult;
    },
    async "tool.session_stop"(raw) {
      const p = raw as SessionScoped;
      const s = sessions.get(p.session_id);
      if (!s) return { returned_tabs: [], closed_tabs: [] } satisfies ToolSessionStopResult;
      const tabs = await sessions.controlledTabs(s);
      for (const t of tabs) if (t.id !== undefined) await cdp.detach(t.id);
      for (const id of s.borrowed.keys()) {
        await cdp.detach(id);
        deps.notifyControlled(id, null);
      }
      const r = await sessions.destroy(p.session_id);
      for (const id of r.returned) deps.notifyControlled(id, null);
      return { returned_tabs: r.returned, closed_tabs: r.closed } satisfies ToolSessionStopResult;
    },

    // ----------------------------------------------------------------------- tabs / window
    async "tool.tab_list"(raw) {
      const p = raw as TabListParams;
      const s = session(p);
      const scope = p.scope ?? "all";
      const all = await chrome.tabs.query({});
      const out: TabInfo[] = [];
      for (const t of all) {
        if (t.id === undefined || t.windowId === undefined) continue;
        const inAgent = t.windowId === s.windowId;
        const otherAgent = !inAgent && sessions.byWindow(t.windowId) !== undefined;
        if (otherAgent) continue;
        const tabScope: "user" | "agent" = inAgent ? "agent" : "user";
        if (scope === "agent" && tabScope !== "agent") continue;
        if (scope === "user" && tabScope !== "user") continue;
        out.push({ tab_id: t.id, window_id: t.windowId, title: t.title, url: t.url, active: t.active, scope: tabScope, ...(s.borrowed.has(t.id) ? { borrowed: true } : {}) });
      }
      return { tabs: out, active_tab_id: s.activeTabId ?? undefined } satisfies TabListResult;
    },
    async "tool.tab_create"(raw) {
      const p = raw as TabCreateParams;
      const s = session(p);
      const t = await chrome.tabs.create({ windowId: s.windowId, url: p.url ?? "about:blank", active: p.active ?? true });
      if (t.id === undefined) fail("internal", "tab create returned no id");
      if (p.active ?? true) s.activeTabId = t.id;
      deps.notifyControlled(t.id, s.id);
      return { tab_id: t.id } satisfies TabCreateResult;
    },
    async "tool.tab_close"(raw) {
      const p = raw as TabIdParams;
      const { s, tabId } = await tab(p);
      if (s.borrowed.has(tabId)) fail("permission_denied", `tab ${tabId} is borrowed; return it instead of closing`, "borrowed_tab_close");
      await cdp.detach(tabId);
      await chrome.tabs.remove(tabId);
      if (s.activeTabId === tabId) s.activeTabId = null;
      return { tab_id: tabId };
    },
    async "tool.tab_select"(raw) {
      const p = raw as TabIdParams;
      const { s, tabId } = await tab(p);
      await chrome.tabs.update(tabId, { active: true });
      s.activeTabId = tabId;
      return { tab_id: tabId };
    },
    async "tool.tab_borrow"(raw) {
      const p = raw as TabIdParams;
      const s = session(p);
      try {
        const r = await sessions.borrowTab(s, p.tab_id);
        deps.notifyControlled(p.tab_id, s.id);
        return { tab_id: p.tab_id, from_window_id: r.fromWindowId, title: r.tab.title, url: r.tab.url };
      } catch (e) {
        fail("permission_denied", String((e as Error).message), "borrow_failed");
      }
    },
    async "tool.tab_return"(raw) {
      const p = raw as TabIdParams;
      const s = session(p);
      try {
        await cdp.detach(p.tab_id);
        const w = await sessions.returnTab(s, p.tab_id);
        deps.notifyControlled(p.tab_id, null);
        return { tab_id: p.tab_id, window_id: w };
      } catch (e) {
        fail("not_found", String((e as Error).message), "return_failed");
      }
    },
    async "tool.window_resize"(raw) {
      const p = raw as WindowResizeParams;
      const s = session(p);
      await chrome.windows.update(s.windowId, { width: p.width, height: p.height, state: "normal" });
      const w = await chrome.windows.get(s.windowId);
      return { window_id: s.windowId, width: w.width, height: w.height };
    },

    // ----------------------------------------------------------------------- navigation
    async "tool.navigate"(raw) {
      const p = raw as NavigateParams;
      const { tab: t, tabId } = await tab(p);
      await assertNoDialog(tabId);
      let url = p.url.trim();
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
      await chrome.tabs.update(tabId, { url });
      const status = await waitTabComplete(tabId, p.timeout_ms ?? 30_000, p.wait_until ?? "load");
      const after = await chrome.tabs.get(tabId);
      void t;
      return { tab_id: tabId, url: after.url ?? url, title: after.title, status } satisfies NavigateResult;
    },
    async "tool.navigate_back"(raw) {
      const p = raw as HistoryParams;
      const { tabId } = await tab(p);
      await chrome.tabs.goBack(tabId);
      const status = await waitTabComplete(tabId, p.timeout_ms ?? 15_000, "load");
      const after = await chrome.tabs.get(tabId);
      return { tab_id: tabId, url: after.url ?? "", title: after.title, status } satisfies NavigateResult;
    },
    async "tool.navigate_forward"(raw) {
      const p = raw as HistoryParams;
      const { tabId } = await tab(p);
      await chrome.tabs.goForward(tabId);
      const status = await waitTabComplete(tabId, p.timeout_ms ?? 15_000, "load");
      const after = await chrome.tabs.get(tabId);
      return { tab_id: tabId, url: after.url ?? "", title: after.title, status } satisfies NavigateResult;
    },
    async "tool.reload"(raw) {
      const p = raw as HistoryParams;
      const { tabId } = await tab(p);
      await chrome.tabs.reload(tabId);
      const status = await waitTabComplete(tabId, p.timeout_ms ?? 30_000, "load");
      const after = await chrome.tabs.get(tabId);
      return { tab_id: tabId, url: after.url ?? "", title: after.title, status } satisfies NavigateResult;
    },

    // ----------------------------------------------------------------------- reads
    async "tool.snapshot"(raw) {
      const p = raw as SnapshotParams;
      const { tab: t, tabId } = await tab(p);
      const r = await page(t, "snapshot", { mode: p.mode ?? "interactive", max_chars: p.max_chars ?? 40_000, root: p.root });
      const dialog = cdp.pendingDialog(tabId);
      return { tab_id: tabId, url: r.url, title: r.title, observation_id: r.observation_id, text: r.text, ref_count: r.refCount, truncated: r.truncated, ...(dialog ? { dialog } : {}) } satisfies SnapshotResult;
    },
    async "tool.find"(raw) {
      const p = raw as FindParams;
      const { tab: t, tabId } = await tab(p);
      const r = await page(t, "find", { query: p.query, limit: p.limit ?? 20 });
      return { tab_id: tabId, observation_id: r.observation_id, matches: r.matches } satisfies FindResult;
    },
    async "tool.get_html"(raw) {
      const p = raw as GetHtmlParams;
      const { tab: t, tabId } = await tab(p);
      const r = await page(t, "get_html", { target: p.target, outer: p.outer, max_chars: p.max_chars });
      if (!r.found) fail("not_found", `target ${p.target} not found`, "selector_not_found");
      return { tab_id: tabId, html: r.html, truncated: r.truncated } satisfies GetHtmlResult;
    },
    async "tool.get_text"(raw) {
      const p = raw as GetTextParams;
      const { tab: t, tabId } = await tab(p);
      const r = await page(t, "get_text", { target: p.target, max_chars: p.max_chars });
      if (!r.found) fail("not_found", `target ${p.target} not found`, "selector_not_found");
      return { tab_id: tabId, url: r.url, title: r.title, text: r.text, truncated: r.truncated } satisfies GetTextResult;
    },
    async "tool.screenshot"(raw) {
      const p = raw as ScreenshotParams;
      const { tab: t, tabId } = await tab(p);
      const format = p.format ?? "png";
      let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
      if (p.target) {
        const r = await resolveTarget(t, p.target);
        clip = { x: Math.max(0, r.x - r.width / 2), y: Math.max(0, r.y - r.height / 2), width: Math.max(1, r.width), height: Math.max(1, r.height), scale: 1 };
      }
      try {
        if (p.full_page && !clip) {
          const m = await cdp.send<{ cssContentSize: { width: number; height: number } }>(tabId, "Page.getLayoutMetrics");
          const { width, height } = m.cssContentSize;
          const cap = 16_384;
          clip = { x: 0, y: 0, width: Math.min(width, cap), height: Math.min(height, cap), scale: 1 };
        }
        const r = await cdp.send<{ data: string }>(tabId, "Page.captureScreenshot", {
          format,
          ...(format === "jpeg" ? { quality: p.quality ?? 80 } : {}),
          ...(clip ? { clip, captureBeyondViewport: true } : {}),
          fromSurface: true,
        });
        const size = clip ? { width: Math.round(clip.width), height: Math.round(clip.height) } : await viewportSize(t);
        return { tab_id: tabId, format, ...size, data: r.data, via: "cdp" } satisfies ScreenshotResult;
      } catch (e) {
        if (!cdpUnavailable(e)) throw e;
        // Fallback: tabs API captures only the active tab of the window.
        if (!t.active) await chrome.tabs.update(tabId, { active: true });
        const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId!, { format, ...(format === "jpeg" ? { quality: p.quality ?? 80 } : {}) });
        const size = await viewportSize(t);
        return { tab_id: tabId, format, ...size, data: dataUrl.replace(/^data:[^,]+,/, ""), via: "tabs_api" } satisfies ScreenshotResult;
      }
    },

    // ----------------------------------------------------------------------- input
    async "tool.click"(raw) {
      const p = raw as ClickParams;
      const { tab: t, tabId } = await tab(p);
      const r = await resolveTarget(t, p.target);
      if (r.disabled) fail("unsupported", `${r.description} is disabled`, "target_disabled");
      if (!r.visible) fail("unsupported", `${r.description} is not in the viewport after scrolling`, "target_hidden");
      let via: "cdp" | "dom" = "cdp";
      if (p.dom) via = "dom";
      else {
        try {
          const mods = (p.modifiers ?? []).reduce((acc, m) => acc | ({ alt: 1, ctrl: 2, meta: 4, shift: 8 }[m] ?? 0), 0);
          await cdpMouse(tabId, r.x, r.y, { button: p.button ?? "left", clickCount: p.click_count ?? 1, modifiers: mods });
        } catch (e) {
          if (!cdpUnavailable(e)) throw e;
          via = "dom";
        }
      }
      if (via === "dom") await page(t, "click_dom", { target: p.target });
      await sleep(50);
      const dialog = cdp.pendingDialog(tabId);
      return { tab_id: tabId, target: p.target, via, navigated_to: await navigatedTo(t), ...(dialog ? { dialog } : {}) } satisfies ActionResult;
    },
    async "tool.hover"(raw) {
      const p = raw as ClickParams;
      const { tab: t, tabId } = await tab(p);
      const r = await resolveTarget(t, p.target);
      try {
        await cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y });
        return { tab_id: tabId, target: p.target, via: "cdp" } satisfies ActionResult;
      } catch (e) {
        if (!cdpUnavailable(e)) throw e;
        fail("unsupported", "hover requires the debugger (CDP) and it is unavailable for this tab", "cdp_unavailable");
      }
    },
    async "tool.fill"(raw) {
      const p = raw as FillParams;
      const { tab: t, tabId } = await tab(p);
      const prep = await page(t, "prepare_fill", { target: p.target });
      if (!prep.found) fail("not_found", `target ${p.target} not found`, "ref_not_found");
      if (!prep.fillable) fail("unsupported", `${prep.description ?? p.target} is not fillable (${prep.reason ?? "not an input"})`, "target_not_fillable");
      let via: "cdp" | "dom" = "cdp";
      if (prep.native_date) via = "dom"; // date/color/range inputs don't accept insertText
      else {
        try {
          await cdp.send(tabId, "Input.insertText", { text: p.value });
          if (p.value === "") {
            // insertText("") is a no-op; clear via select-all + delete.
            await pressKey(tabId, "Delete");
          }
          const check = await page(t, "read_value", { target: p.target });
          if (check.found && typeof check.value === "string" && check.value !== p.value && prep.kind !== "contenteditable") via = "dom";
        } catch (e) {
          if (!cdpUnavailable(e)) throw e;
          via = "dom";
        }
      }
      if (via === "dom") await page(t, "fill_dom", { target: p.target, value: p.value });
      if (p.submit) {
        try {
          await pressKey(tabId, "Enter");
        } catch (e) {
          if (!cdpUnavailable(e)) throw e;
          await page(t, "click_dom", { target: `${p.target}` });
        }
        await sleep(150);
      }
      return { tab_id: tabId, target: p.target, via, navigated_to: await navigatedTo(t) } satisfies ActionResult;
    },
    async "tool.type"(raw) {
      const p = raw as TypeParams;
      const { tabId } = await tab(p);
      await assertNoDialog(tabId);
      try {
        if (p.delay_ms && p.delay_ms > 0) {
          for (const ch of p.text) {
            await cdp.send(tabId, "Input.insertText", { text: ch });
            await sleep(p.delay_ms);
          }
        } else await cdp.send(tabId, "Input.insertText", { text: p.text });
      } catch (e) {
        if (!cdpUnavailable(e)) throw e;
        fail("unsupported", "type requires the debugger (CDP); use `bctl fill` on a target instead", "cdp_unavailable");
      }
      return { tab_id: tabId, target: "focused", via: "cdp" } satisfies ActionResult;
    },
    async "tool.press"(raw) {
      const p = raw as PressParams;
      const { tab: t, tabId } = await tab(p);
      await assertNoDialog(tabId);
      if (p.target) await page(t, "focus", { target: p.target });
      try {
        await pressKey(tabId, p.key);
      } catch (e) {
        if (e instanceof CdpError && !cdpUnavailable(e)) throw e;
        if (!(e instanceof CdpError)) fail("invalid_params", String((e as Error).message), "bad_key");
        fail("unsupported", "press requires the debugger (CDP) and it is unavailable for this tab", "cdp_unavailable");
      }
      await sleep(50);
      const dialog = cdp.pendingDialog(tabId);
      return { tab_id: tabId, target: p.target ?? "focused", via: "cdp", navigated_to: await navigatedTo(t), ...(dialog ? { dialog } : {}) } satisfies ActionResult;
    },
    async "tool.select"(raw) {
      const p = raw as SelectParams;
      const { tab: t, tabId } = await tab(p);
      const r = await page(t, "select_dom", { target: p.target, values: p.values });
      if (!r.found) fail("not_found", `target ${p.target} not found`, "ref_not_found");
      if (!r.is_select) fail("unsupported", `${p.target} is not a <select>; click the control and choose an option instead`, "target_not_select");
      if (r.missing?.length) fail("not_found", `option(s) not found: ${r.missing.join(", ")}`, "option_not_found", "use the option's value attribute or exact visible label");
      return { tab_id: tabId, target: p.target, via: "dom", selected: r.selected } satisfies SelectResult;
    },
    async "tool.check"(raw) {
      const p = raw as CheckParams;
      const { tab: t, tabId } = await tab(p);
      const r = await page(t, "check_dom", { target: p.target, checked: p.checked });
      if (!r.found) fail("not_found", `target ${p.target} not found`, "ref_not_found");
      return { tab_id: tabId, target: p.target, via: "dom", checked: r.checked };
    },
    async "tool.scroll"(raw) {
      const p = raw as ScrollParams;
      const { tab: t, tabId } = await tab(p);
      const r = await page(t, "scroll", { target: p.target, delta_x: p.delta_x, delta_y: p.delta_y, to: p.to });
      return { tab_id: tabId, scroll_x: r.scroll_x, scroll_y: r.scroll_y, at_bottom: r.at_bottom } satisfies ScrollResult;
    },
    async "tool.scroll_to"(raw) {
      const p = raw as ClickParams;
      const { tab: t, tabId } = await tab(p);
      const r = await page(t, "scroll_to", { target: p.target });
      if (!r.found) fail("not_found", `target ${p.target} not found`, "ref_not_found");
      return { tab_id: tabId, target: p.target, via: "dom" } satisfies ActionResult;
    },

    // ----------------------------------------------------------------------- script / debugging
    async "tool.evaluate"(raw) {
      const p = raw as EvaluateParams;
      const { tab: t, tabId } = await tab(p);
      assertScriptable(t);
      await assertNoDialog(tabId);
      try {
        const r = await cdp.send<{ result: { type: string; value?: unknown; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(tabId, "Runtime.evaluate", {
          expression: p.expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
          timeout: p.timeout_ms ?? 15_000,
        });
        if (r.exceptionDetails) fail("internal", r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluation threw", "evaluate_threw");
        return { tab_id: tabId, value: r.result.value ?? r.result.description ?? null, type: r.result.type } satisfies EvaluateResult;
      } catch (e) {
        if (!cdpUnavailable(e)) throw e;
        // Fallback: MAIN-world executeScript with Function constructor (blocked by strict page CSP).
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: p.world === "isolated" ? "ISOLATED" : "MAIN",
          func: (src: string) => {
            try {
              // eslint-disable-next-line no-new-func
              const v = new Function(`return (${src})`)();
              return { ok: true, value: v, type: typeof v };
            } catch (err) {
              return { ok: false, error: String((err as Error)?.message ?? err) };
            }
          },
          args: [p.expression],
        });
        const r = results[0]?.result as { ok: boolean; value?: unknown; type?: string; error?: string };
        if (!r?.ok) fail("internal", r?.error ?? "evaluation failed", "evaluate_threw");
        return { tab_id: tabId, value: r.value ?? null, type: r.type ?? "undefined" } satisfies EvaluateResult;
      }
    },
    async "tool.console"(raw) {
      const p = raw as ConsoleParams;
      const { tab: t, tabId } = await tab(p);
      assertScriptable(t);
      let capturing = true;
      try {
        await cdp.attach(tabId);
      } catch {
        capturing = false;
      }
      const c = cdp.capture(tabId);
      let entries = c.console.filter((e) => (p.since_seq ? e.seq > p.since_seq : true) && (p.level ? e.level.includes(p.level) : true));
      if (p.limit) entries = entries.slice(-p.limit);
      if (p.clear) c.console.length = 0;
      return { tab_id: tabId, entries, capturing } satisfies ConsoleResult;
    },
    async "tool.network"(raw) {
      const p = raw as NetworkParams;
      const { tab: t, tabId } = await tab(p);
      assertScriptable(t);
      let capturing = true;
      try {
        await cdp.attach(tabId);
      } catch {
        capturing = false;
      }
      const c = cdp.capture(tabId);
      let body: NetworkResult["body"];
      if (p.body_for) {
        try {
          const r = await cdp.send<{ body: string; base64Encoded: boolean }>(tabId, "Network.getResponseBody", { requestId: p.body_for });
          const max = 512 * 1024;
          body = { request_id: p.body_for, base64: r.base64Encoded, body: r.body.slice(0, max), truncated: r.body.length > max };
        } catch (e) {
          fail("not_found", `response body unavailable for ${p.body_for}: ${(e as Error).message}`, "body_unavailable", "bodies are only retained for requests observed while capturing");
        }
      }
      let entries = c.network.filter((e) => (p.since_seq ? e.seq > p.since_seq : true) && (p.filter ? e.url.includes(p.filter) || e.method === p.filter : true));
      if (p.limit) entries = entries.slice(-p.limit);
      if (p.clear) c.network.length = 0;
      return { tab_id: tabId, entries, capturing, ...(body ? { body } : {}) } satisfies NetworkResult;
    },

    // ----------------------------------------------------------------------- waits
    async "tool.wait_for_element"(raw) {
      const p = raw as WaitForElementParams;
      const { tab: t, tabId } = await tab(p);
      const start = Date.now();
      const deadline = start + (p.timeout_ms ?? 10_000);
      while (true) {
        const r = await page(t, "wait_state", { target: p.target, state: p.state ?? "visible" }).catch(() => ({ matched: false }));
        if (r.matched) return { tab_id: tabId, matched: true, elapsed_ms: Date.now() - start } satisfies WaitForElementResult;
        if (Date.now() >= deadline) return { tab_id: tabId, matched: false, elapsed_ms: Date.now() - start } satisfies WaitForElementResult;
        await sleep(150);
      }
    },
    async "tool.wait_for_navigation"(raw) {
      const p = raw as WaitForNavigationParams;
      const { tabId } = await tab(p);
      const deadline = Date.now() + (p.timeout_ms ?? 15_000);
      while (Date.now() < deadline) {
        const t = await chrome.tabs.get(tabId).catch(() => null);
        if (!t) fail("not_found", `tab ${tabId} closed`, "tab_closed");
        const urlOk = p.url_includes ? (t.url ?? "").includes(p.url_includes) : true;
        if (urlOk && t.status === "complete") return { tab_id: tabId, url: t.url ?? "", reached: "load" } satisfies WaitForNavigationResult;
        await sleep(100);
      }
      const t = await chrome.tabs.get(tabId).catch(() => null);
      return { tab_id: tabId, url: t?.url ?? "", reached: "timeout" } satisfies WaitForNavigationResult;
    },

    // ----------------------------------------------------------------------- dialogs
    async "tool.dialog_status"(raw) {
      const p = raw as TabScoped;
      const { tabId } = await tab(p);
      const d = cdp.pendingDialog(tabId);
      return { tab_id: tabId, ...(d ? { dialog: d } : {}) } satisfies DialogStatusResult;
    },
    async "tool.dialog_handle"(raw) {
      const p = raw as DialogHandleParams;
      const { tabId } = await tab(p);
      const d = cdp.pendingDialog(tabId);
      if (!d) return { tab_id: tabId, handled: false } satisfies DialogHandleResult;
      await cdp.send(tabId, "Page.handleJavaScriptDialog", { accept: p.accept, ...(p.text !== undefined ? { promptText: p.text } : {}) });
      return { tab_id: tabId, handled: true } satisfies DialogHandleResult;
    },

    // ----------------------------------------------------------------------- misc
    async "tool.cookies"(raw) {
      const p = raw as CookiesParams;
      const { tab: t, tabId } = await tab(p);
      const url = t.url ?? "";
      const cookies = await chrome.cookies.getAll(p.domain ? { domain: p.domain } : { url });
      // Values are intentionally never returned: agents get presence/metadata only.
      return { tab_id: tabId, cookies: cookies.map((c) => ({ name: c.name, domain: c.domain, path: c.path, secure: c.secure, http_only: c.httpOnly, expires: c.expirationDate })) } satisfies CookiesResult;
    },
    async "tool.pdf"(raw) {
      const p = raw as PdfParams;
      const { tabId } = await tab(p);
      try {
        const r = await cdp.send<{ data: string }>(tabId, "Page.printToPDF", { landscape: p.landscape ?? false, printBackground: true });
        return { tab_id: tabId, data: r.data } satisfies PdfResult;
      } catch (e) {
        if (cdpUnavailable(e)) fail("unsupported", "pdf export requires the debugger (CDP)", "cdp_unavailable");
        throw e;
      }
    },
  };
  return tools;
}

async function viewportSize(t: chrome.tabs.Tab): Promise<{ width: number; height: number }> {
  return { width: t.width ?? 0, height: t.height ?? 0 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
