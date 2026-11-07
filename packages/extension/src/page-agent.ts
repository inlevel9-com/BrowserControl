// Page-side agent. `pageAgent` is serialised by chrome.scripting.executeScript and runs inside the
// tab's ISOLATED world, so it must be self-contained: no imports, no closures over module scope.
// State (ref map, counters) is cached on globalThis and survives across calls for one document.

export type PageOp =
  | "snapshot"
  | "resolve"
  | "find"
  | "get_html"
  | "get_text"
  | "scroll"
  | "scroll_to"
  | "fill_dom"
  | "click_dom"
  | "check_dom"
  | "select_dom"
  | "focus"
  | "prepare_fill"
  | "wait_state"
  | "page_info"
  | "read_value"
  | "file_input"
  | "set_files"
  | "link_url"
  | "tables";

export interface SnapshotNode {
  ref?: string;
  role: string;
  name: string;
  text?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pageAgent(op: PageOp, args: any): any {
  type State = {
    refs: Map<string, Element>;
    byEl: WeakMap<Element, string>;
    next: number;
    observationId: string;
    docKey: string;
  };
  const g = globalThis as unknown as { __bctl?: State };
  const docKey = `${location.href}#${(document.documentElement as HTMLElement & { __bctlDoc?: number }).__bctlDoc ?? 0}`;
  if (!g.__bctl || g.__bctl.docKey !== docKey) {
    g.__bctl = { refs: new Map(), byEl: new WeakMap(), next: 1, observationId: "", docKey };
  }
  const S = g.__bctl;

  const INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "textarea", "summary", "option", "label"]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "textbox", "combobox", "listbox", "option", "menuitem", "menuitemcheckbox",
    "menuitemradio", "tab", "switch", "slider", "spinbutton", "searchbox", "treeitem", "gridcell", "row",
  ]);
  const LANDMARK_TAGS: Record<string, string> = {
    nav: "navigation", main: "main", header: "banner", footer: "contentinfo", aside: "complementary", form: "form",
    section: "region", article: "article", dialog: "dialog", table: "table", ul: "list", ol: "list", li: "listitem",
    img: "img", h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading", p: "paragraph",
    video: "video", audio: "audio", iframe: "iframe", details: "group", fieldset: "group", legend: "legend",
  };

  function isVisible(el: Element): boolean {
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    if (el instanceof HTMLElement && el.hidden) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && !(el.tagName === "OPTION")) return false;
    return true;
  }
  function norm(s: string | null | undefined): string {
    return (s ?? "").replace(/\s+/g, " ").trim();
  }
  function roleOf(el: Element): string {
    const explicit = norm(el.getAttribute("role")).split(" ")[0];
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return (el as HTMLAnchorElement).hasAttribute("href") ? "link" : "generic";
    if (tag === "input") {
      const t = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "search") return "searchbox";
      if (t === "hidden") return "hidden";
      if (t === "file") return "filebutton";
      return "textbox";
    }
    if (tag === "select") return (el as HTMLSelectElement).multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "option") return "option";
    if (tag === "label") return "label";
    if ((el as HTMLElement).isContentEditable && el.getAttribute("contenteditable") !== null) return "textbox";
    if (LANDMARK_TAGS[tag]) return LANDMARK_TAGS[tag];
    return "generic";
  }
  function labelText(el: Element): string {
    const id = el.getAttribute("id");
    if (id) {
      const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lab) return norm(lab.textContent);
    }
    const wrap = el.closest("label");
    if (wrap) return norm(wrap.textContent);
    return "";
  }
  function nameOf(el: Element, role: string): string {
    const aria = norm(el.getAttribute("aria-label"));
    if (aria) return aria;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const parts = by.split(/\s+/).map((i) => norm(document.getElementById(i)?.textContent)).filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") {
      const l = labelText(el);
      if (l) return l;
      const ph = norm(el.getAttribute("placeholder"));
      if (ph) return ph;
      const v = (el as HTMLInputElement).value;
      if (role === "button" && v) return norm(v);
      return norm(el.getAttribute("name") || el.getAttribute("title"));
    }
    if (tag === "img") return norm(el.getAttribute("alt") || el.getAttribute("title"));
    const title = norm(el.getAttribute("title"));
    const txt = norm((el as HTMLElement).innerText ?? el.textContent);
    if (txt) return txt.length > 120 ? `${txt.slice(0, 117)}…` : txt;
    if (title) return title;
    const img = el.querySelector("img[alt], svg[aria-label], [aria-label]");
    if (img) return norm(img.getAttribute("alt") || img.getAttribute("aria-label"));
    return "";
  }
  function isInteractive(el: Element, role: string): boolean {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag) && role !== "generic" && role !== "hidden" && role !== "label") return true;
    if (INTERACTIVE_ROLES.has(role)) return true;
    if ((el as HTMLElement).isContentEditable) return true;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && Number(ti) >= 0) return true;
    if (el.hasAttribute("onclick")) return true;
    const cs = getComputedStyle(el);
    if (cs.cursor === "pointer" && tag !== "body" && tag !== "html") {
      const parent = el.parentElement;
      if (parent && getComputedStyle(parent).cursor === "pointer") return false; // only the outermost pointer element
      return true;
    }
    return false;
  }
  function refFor(el: Element): string {
    let r = S.byEl.get(el);
    if (!r) {
      r = `e${S.next++}`;
      S.byEl.set(el, r);
    }
    S.refs.set(r, el);
    return r;
  }
  function extras(el: Element, role: string): string {
    const parts: string[] = [];
    const tag = el.tagName.toLowerCase();
    if (role === "link") {
      const href = el.getAttribute("href");
      if (href && !href.startsWith("javascript:")) parts.push(`href=${JSON.stringify(href.length > 80 ? `${href.slice(0, 77)}…` : href)}`);
    }
    if (role === "heading") parts.push(`level=${tag.length === 2 && /h[1-6]/.test(tag) ? tag[1] : el.getAttribute("aria-level") ?? "?"}`);
    if (tag === "input" || tag === "textarea") {
      const inp = el as HTMLInputElement;
      const t = (inp.type || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") parts.push(inp.checked ? "checked" : "unchecked");
      else if (t !== "password" && inp.value) parts.push(`value=${JSON.stringify(inp.value.length > 60 ? `${inp.value.slice(0, 57)}…` : inp.value)}`);
      if (t === "password") parts.push("type=password");
      if (inp.required) parts.push("required");
    }
    if (tag === "select") {
      const sel = el as HTMLSelectElement;
      const opts = Array.from(sel.options).slice(0, 12).map((o) => (o.selected ? `*${o.value}` : o.value));
      parts.push(`options=[${opts.join(",")}${sel.options.length > 12 ? ",…" : ""}]`);
    }
    if (role === "checkbox" || role === "radio" || role === "switch") {
      const ac = el.getAttribute("aria-checked");
      if (ac && tag !== "input") parts.push(ac === "true" ? "checked" : "unchecked");
    }
    if (el.getAttribute("aria-expanded")) parts.push(`expanded=${el.getAttribute("aria-expanded")}`);
    if (el.getAttribute("aria-selected") === "true") parts.push("selected");
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    return parts.length ? ` [${parts.join(" ")}]` : "";
  }

  function snapshot(mode: "interactive" | "full", maxChars: number, rootSel?: string): { text: string; refCount: number; truncated: boolean } {
    let root: Element = document.body ?? document.documentElement;
    if (rootSel) {
      const r = resolveTarget(rootSel);
      if (r) root = r;
    }
    S.observationId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    S.refs.clear();
    const lines: string[] = [];
    let refCount = 0;
    let chars = 0;
    let truncated = false;
    const seenText = new Set<string>();
    function push(depth: number, line: string): boolean {
      if (chars + line.length + 1 > maxChars) {
        truncated = true;
        return false;
      }
      lines.push(`${"  ".repeat(depth)}${line}`);
      chars += line.length + 1;
      return true;
    }
    function walk(el: Element, depth: number): void {
      if (truncated) return;
      if (!isVisible(el)) return;
      const tag = el.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") return;
      const role = roleOf(el);
      const interactive = isInteractive(el, role);
      let emitted = false;
      if (interactive) {
        const ref = refFor(el);
        refCount++;
        push(depth, `- ${role} ${JSON.stringify(nameOf(el, role))} @${ref}${extras(el, role)}`);
        emitted = true;
        if (tag === "select" || tag === "textarea" || tag === "input" || tag === "button" || role === "link") return; // leaf
      } else if (role === "heading" || role === "img" || role === "dialog" || role === "iframe") {
        const name = nameOf(el, role);
        if (name || role === "iframe") {
          const ref = role === "iframe" ? ` @${refFor(el)}` : "";
          push(depth, `- ${role} ${JSON.stringify(name)}${ref}${extras(el, role)}`);
          emitted = true;
          if (role !== "dialog") return;
        }
      } else if (["navigation", "main", "banner", "contentinfo", "complementary", "form", "table", "list", "listitem", "region", "article", "group"].includes(role)) {
        const name = norm(el.getAttribute("aria-label")) || (role === "region" ? "" : "");
        if (role !== "listitem" && role !== "group") {
          push(depth, `- ${role}${name ? ` ${JSON.stringify(name)}` : ""}`);
          emitted = true;
        }
      }
      const childDepth = emitted ? depth + 1 : depth;
      // Text nodes
      for (const node of Array.from(el.childNodes)) {
        if (truncated) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const t = norm(node.textContent);
          if (!t) continue;
          if (mode === "interactive" && t.length < 2) continue;
          const key = t.slice(0, 200);
          if (seenText.has(key)) continue;
          seenText.add(key);
          const clipped = mode === "interactive" && t.length > 240 ? `${t.slice(0, 237)}…` : t;
          push(childDepth, `- text: ${JSON.stringify(clipped)}`);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          walk(node as Element, childDepth);
        }
      }
      // Shadow DOM
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) for (const c of Array.from(sr.children)) walk(c, childDepth);
    }
    walk(root, 0);
    return { text: lines.join("\n"), refCount, truncated };
  }

  function resolveTarget(target: string): Element | null {
    const m = /^@?e(\d+)$/.exec(target.trim());
    if (m) {
      const el = S.refs.get(`e${m[1]}`);
      return el && el.isConnected ? el : null;
    }
    try {
      return document.querySelector(target);
    } catch {
      return null;
    }
  }
  function centerOf(el: Element): { x: number; y: number; width: number; height: number; visible: boolean } {
    const rects = Array.from(el.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    const r = rects[0] ?? el.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, Math.max(1, r.width / 2));
    const y = r.top + Math.min(r.height / 2, Math.max(1, r.height / 2));
    const inView = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
    return { x, y, width: r.width, height: r.height, visible: inView && r.width > 0 && r.height > 0 };
  }
  function describe(el: Element): string {
    const role = roleOf(el);
    return `${role} ${JSON.stringify(nameOf(el, role))}`;
  }
  function hitOk(el: Element, x: number, y: number): boolean {
    const top = document.elementFromPoint(x, y);
    if (!top) return false;
    if (top === el || el.contains(top) || top.contains(el)) return true;
    // Labels/inputs: label click still reaches input
    const topRoot = (top.getRootNode() as ShadowRoot).host;
    if (topRoot && (topRoot === el || el.contains(topRoot))) return true;
    return false;
  }
  function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
  }

  switch (op) {
    case "page_info":
      return { url: location.href, title: document.title, ready: document.readyState, scrollX, scrollY, innerWidth, innerHeight, observation_id: S.observationId };
    case "snapshot": {
      const r = snapshot(args.mode ?? "interactive", args.max_chars ?? 40_000, args.root);
      return { ...r, url: location.href, title: document.title, observation_id: S.observationId };
    }
    case "find": {
      const q = String(args.query ?? "").toLowerCase();
      const limit = args.limit ?? 20;
      const out: SnapshotNode[] = [];
      const all = document.querySelectorAll("*");
      for (const el of Array.from(all)) {
        if (out.length >= limit) break;
        if (!isVisible(el)) continue;
        const role = roleOf(el);
        if (!isInteractive(el, role) && role !== "heading") continue;
        const name = nameOf(el, role);
        const hay = `${role} ${name} ${el.id} ${el.getAttribute("placeholder") ?? ""}`.toLowerCase();
        if (hay.includes(q)) out.push({ ref: refFor(el), role, name });
      }
      if (!S.observationId) S.observationId = `${Date.now().toString(36)}`;
      return { matches: out, observation_id: S.observationId };
    }
    case "resolve": {
      const el = resolveTarget(args.target);
      if (!el) return { found: false };
      if (args.scroll !== false) {
        try {
          el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
        } catch {
          /* ignore */
        }
      }
      const c = centerOf(el);
      const tag = el.tagName.toLowerCase();
      const disabled = (el as HTMLButtonElement).disabled === true;
      return { found: true, ...c, tag, description: describe(el), disabled, covered: c.visible ? !hitOk(el, c.x, c.y) : false };
    }
    case "get_html": {
      const el = args.target ? resolveTarget(args.target) : document.documentElement;
      if (!el) return { found: false };
      const html = args.outer === false ? el.innerHTML : el.outerHTML;
      const max = args.max_chars ?? 200_000;
      return { found: true, html: html.slice(0, max), truncated: html.length > max };
    }
    case "get_text": {
      const el = args.target ? resolveTarget(args.target) : document.body;
      if (!el) return { found: false };
      const text = ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
      const max = args.max_chars ?? 100_000;
      return { found: true, url: location.href, title: document.title, text: text.slice(0, max), truncated: text.length > max };
    }
    case "scroll": {
      const el = args.target ? resolveTarget(args.target) : null;
      const scroller: Element | Window = el ?? window;
      if (args.to === "top") (scroller as Window).scrollTo?.({ top: 0 }) ?? ((scroller as Element).scrollTop = 0);
      else if (args.to === "bottom") {
        if (scroller === window) window.scrollTo({ top: document.documentElement.scrollHeight });
        else (scroller as Element).scrollTop = (scroller as Element).scrollHeight;
      } else {
        const dx = args.delta_x ?? 0;
        const dy = args.delta_y ?? 0;
        if (scroller === window) window.scrollBy({ left: dx, top: dy });
        else {
          (scroller as Element).scrollLeft += dx;
          (scroller as Element).scrollTop += dy;
        }
      }
      const sx = scroller === window ? window.scrollX : (scroller as Element).scrollLeft;
      const sy = scroller === window ? window.scrollY : (scroller as Element).scrollTop;
      const atBottom = scroller === window
        ? Math.ceil(window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight - 1
        : Math.ceil((scroller as Element).clientHeight + (scroller as Element).scrollTop) >= (scroller as Element).scrollHeight - 1;
      return { scroll_x: sx, scroll_y: sy, at_bottom: atBottom };
    }
    case "scroll_to": {
      const el = resolveTarget(args.target);
      if (!el) return { found: false };
      el.scrollIntoView({ block: args.block ?? "center", behavior: "instant" as ScrollBehavior });
      return { found: true, ...centerOf(el) };
    }
    case "focus": {
      const el = resolveTarget(args.target);
      if (!el) return { found: false };
      (el as HTMLElement).focus?.();
      return { found: true, focused: document.activeElement === el };
    }
    case "prepare_fill": {
      // Focus and select existing content so a CDP Input.insertText replaces it.
      const el = resolveTarget(args.target);
      if (!el) return { found: false };
      const tag = el.tagName.toLowerCase();
      const editable = (el as HTMLElement).isContentEditable;
      if (!(tag === "input" || tag === "textarea" || editable)) {
        // maybe a wrapper: find an inner editable
        const inner = el.querySelector("input, textarea, [contenteditable=''], [contenteditable='true']");
        if (!inner) return { found: true, fillable: false, description: describe(el) };
        return pageAgent("prepare_fill", { target: `@${refFor(inner)}` });
      }
      if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) return { found: true, fillable: false, reason: "disabled_or_readonly" };
      el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
      (el as HTMLElement).focus();
      if (tag === "input" || tag === "textarea") {
        const inp = el as HTMLInputElement;
        try {
          inp.select();
        } catch {
          /* type=email etc. may not support select() */
        }
        const t = (inp.type || "text").toLowerCase();
        return { found: true, fillable: true, kind: t, ref: refFor(el), native_date: ["date", "time", "datetime-local", "month", "week", "color", "range", "file"].includes(t) };
      }
      const sel = getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);
      return { found: true, fillable: true, kind: "contenteditable", ref: refFor(el) };
    }
    case "fill_dom": {
      const el = resolveTarget(args.target);
      if (!el) return { found: false };
      const tag = el.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea") {
        const inp = el as HTMLInputElement;
        inp.focus();
        setNativeValue(inp, String(args.value));
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        return { found: true, value: inp.value };
      }
      if ((el as HTMLElement).isContentEditable) {
        (el as HTMLElement).focus();
        el.textContent = String(args.value);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(args.value), inputType: "insertText" }));
        return { found: true, value: el.textContent };
      }
      return { found: true, fillable: false };
    }
    case "read_value": {
      const el = resolveTarget(args.target);
      if (!el) return { found: false };
      const v = (el as HTMLInputElement).value ?? (el as HTMLElement).textContent;
      return { found: true, value: v };
    }
    case "click_dom": {
      const el = resolveTarget(args.target) as HTMLElement | null;
      if (!el) return { found: false };
      el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
      const c = centerOf(el);
      const init = { bubbles: true, cancelable: true, clientX: c.x, clientY: c.y, button: 0 };
      el.dispatchEvent(new PointerEvent("pointerdown", init));
      el.dispatchEvent(new MouseEvent("mousedown", init));
      el.focus?.();
      el.dispatchEvent(new PointerEvent("pointerup", init));
      el.dispatchEvent(new MouseEvent("mouseup", init));
      el.click();
      return { found: true };
    }
    case "check_dom": {
      const el = resolveTarget(args.target) as HTMLInputElement | null;
      if (!el) return { found: false };
      const want = !!args.checked;
      if (el.tagName.toLowerCase() === "input" && (el.type === "checkbox" || el.type === "radio")) {
        if (el.checked !== want) el.click();
        return { found: true, checked: el.checked, changed: el.checked === want };
      }
      const cur = el.getAttribute("aria-checked") === "true";
      if (cur !== want) (el as HTMLElement).click();
      return { found: true, checked: el.getAttribute("aria-checked") === "true" };
    }
    case "select_dom": {
      const el = resolveTarget(args.target) as HTMLSelectElement | null;
      if (!el) return { found: false };
      if (el.tagName.toLowerCase() !== "select") return { found: true, is_select: false };
      const values: string[] = args.values ?? [];
      const selected: string[] = [];
      const missing: string[] = [];
      for (const o of Array.from(el.options)) o.selected = false;
      for (const v of values) {
        const opt = Array.from(el.options).find((o) => o.value === v) ?? Array.from(el.options).find((o) => norm(o.textContent) === v);
        if (opt) {
          opt.selected = true;
          selected.push(opt.value);
          if (!el.multiple) break;
        } else missing.push(v);
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { found: true, is_select: true, selected, missing };
    }
    case "wait_state": {
      const el = resolveTarget(args.target);
      const state: string = args.state ?? "visible";
      if (state === "attached") return { matched: !!el };
      if (state === "detached") return { matched: !el };
      if (state === "visible") return { matched: !!el && isVisible(el) };
      if (state === "hidden") return { matched: !el || !isVisible(el) };
      return { matched: false };
    }
    case "file_input": {
      // Find the <input type=file> a target stands for: the input itself, a label's control,
      // or a single file input inside the target.
      const el = resolveTarget(args.target);
      if (!el) return { found: false };
      const isFile = (e: Element | null | undefined): e is HTMLInputElement => !!e && e.tagName === "INPUT" && (e as HTMLInputElement).type.toLowerCase() === "file";
      let input: HTMLInputElement | null = null;
      if (isFile(el)) input = el;
      else if (el.tagName === "LABEL" && isFile((el as HTMLLabelElement).control)) input = (el as HTMLLabelElement).control as HTMLInputElement;
      else {
        const inner = el.querySelectorAll("input[type=file]");
        if (inner.length === 1) input = inner[0] as HTMLInputElement;
      }
      if (!input) return { found: true, kind: "other", description: describe(el) };
      return { found: true, kind: "input", ref: refFor(input), multiple: input.multiple, accept: input.accept, disabled: input.disabled, description: describe(input) };
    }
    case "set_files": {
      const el = resolveTarget(args.target) as HTMLInputElement | null;
      if (!el) return { found: false };
      if (el.tagName !== "INPUT" || el.type.toLowerCase() !== "file") return { found: true, ok: false, reason: "not_file_input" };
      const files: Array<{ name: string; mime?: string; data: string }> = args.files ?? [];
      if (files.length > 1 && !el.multiple) return { found: true, ok: false, reason: "not_multiple" };
      const dt = new DataTransfer();
      for (const f of files) {
        const bin = atob(f.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], f.name, { type: f.mime || "application/octet-stream", lastModified: Date.now() }));
      }
      el.files = dt.files;
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { found: true, ok: true, names: Array.from(el.files ?? []).map((f) => f.name), multiple: el.multiple };
    }
    case "link_url": {
      const el = resolveTarget(args.target);
      if (!el) return { found: false };
      const a = (el.closest("a[href]") ?? el.querySelector("a[href]")) as HTMLAnchorElement | null;
      if (!a) return { found: true, url: null, description: describe(el) };
      return { found: true, url: a.href, download: a.getAttribute("download") };
    }
    case "tables": {
      const maxRows: number = args.max_rows ?? 500;
      const scope: Element | null = args.target ? resolveTarget(args.target) : document.body;
      if (!scope) return { found: false };
      const SEL = "table, [role=table], [role=grid], [role=treegrid]";
      let candidates: Element[] = scope.matches(SEL) ? [scope] : Array.from(scope.querySelectorAll(SEL));
      if (!scope.matches(SEL)) {
        const outer = scope.closest(SEL);
        if (outer && candidates.length === 0) candidates = [outer];
      }
      candidates = candidates.filter((t) => {
        const r = (t.getAttribute("role") ?? "").toLowerCase();
        return r !== "presentation" && r !== "none" && isVisible(t);
      });
      const cellText = (c: Element): string => norm((c as HTMLElement).innerText ?? c.textContent);
      const tables = [];
      for (const t of candidates) {
        let header: string[][] = [];
        let body: string[][] = [];
        if (t.tagName === "TABLE") {
          // Expand rowspan/colspan into a rectangular grid.
          const rows = Array.from((t as HTMLTableElement).rows);
          const grid: string[][] = [];
          const isHead: boolean[] = [];
          const hasThead = !!(t as HTMLTableElement).tHead;
          const pending: Array<{ left: number; text: string } | undefined> = [];
          rows.forEach((tr, ri) => {
            const line: string[] = [];
            let col = 0;
            const place = (text: string) => {
              line[col] = text;
              col++;
            };
            const fillPending = () => {
              while (pending[col] && pending[col]!.left > 0) {
                place(pending[col]!.text);
                pending[col - 1]!.left--;
              }
            };
            fillPending();
            for (const cell of Array.from(tr.cells)) {
              fillPending();
              const text = cellText(cell);
              const cs = Math.max(1, Math.min(cell.colSpan || 1, 100));
              const rs = Math.max(1, Math.min(cell.rowSpan || 1, 1000));
              for (let k = 0; k < cs; k++) {
                if (rs > 1) pending[col] = { left: rs - 1, text };
                place(text);
              }
            }
            fillPending();
            grid[ri] = line;
            const section = tr.parentElement?.tagName;
            const allTh = tr.cells.length > 0 && Array.from(tr.cells).every((c) => c.tagName === "TH");
            // Without <thead>, leading rows made only of <th> are the header.
            isHead[ri] = section === "THEAD" || (!hasThead && allTh && (ri === 0 || isHead[ri - 1] === true));
          });
          const width = Math.max(0, ...grid.map((r) => r.length));
          for (const r of grid) for (let i = 0; i < width; i++) if (r[i] === undefined) r[i] = "";
          grid.forEach((r, i) => (isHead[i] ? header : body).push(r));
        } else {
          const rows = Array.from(t.querySelectorAll("[role=row]")).filter((r) => r.closest(SEL) === t);
          for (const r of rows) {
            const cells = Array.from(r.querySelectorAll("[role=cell], [role=gridcell], [role=columnheader], [role=rowheader]")).filter((c) => c.closest("[role=row]") === r);
            const line = cells.map(cellText);
            if (cells.length && cells.every((c) => c.getAttribute("role") === "columnheader")) header.push(line);
            else body.push(line);
          }
        }
        if (header.length === 0 && body.length === 0) continue;
        const width = Math.max(0, ...header.map((r) => r.length), ...body.map((r) => r.length));
        const headers: string[] = [];
        for (let i = 0; i < width; i++) {
          const parts: string[] = [];
          for (const h of header) {
            const v = h[i] ?? "";
            if (v && parts[parts.length - 1] !== v) parts.push(v);
          }
          headers.push(parts.join(" / "));
        }
        body = body.map((r) => {
          const out = r.slice();
          while (out.length < width) out.push("");
          return out;
        });
        const caption = t.tagName === "TABLE" ? norm((t as HTMLTableElement).caption?.textContent) : norm(t.getAttribute("aria-label"));
        tables.push({
          index: tables.length,
          ref: refFor(t),
          kind: t.tagName === "TABLE" ? "table" : (t.getAttribute("role") ?? "table"),
          ...(caption ? { caption } : {}),
          headers,
          rows: body.slice(0, maxRows),
          row_count: body.length,
          column_count: width,
          truncated: body.length > maxRows,
        });
      }
      return { found: true, url: location.href, tables };
    }
    default:
      return { error: `unknown op ${op}` };
  }
}
