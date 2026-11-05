// BrowserControl wire protocol — shared by the bctl CLI/daemon and the extension.
//
// Three frame shapes travel on both links (CLI↔daemon JSON lines, daemon↔extension WebSocket):
//   request  { id, method, params? }
//   response { id, result } | { id, error: { code, message, data? } }
//   event    { event, payload? }
// The transport never interprets frames; routing happens in the daemon and the extension dispatcher.

export const PROTOCOL_VERSION = "1.0";
export const DEFAULT_WS_PORT = 52810;
export const EXTENSION_CLIENT_ID = "browser-control-extension";
export const DAEMON_SERVER_ID = "bctl-daemon";

export type RpcId = string;

export type ErrorCode =
  | "unknown_method"
  | "unsupported"
  | "invalid_params"
  | "not_found"
  | "permission_denied"
  | "timeout"
  | "dialog_pending"
  | "cdp_failed"
  | "protocol_error"
  | "cancelled"
  | "user_aborted"
  | "version_mismatch"
  | "multiple_browsers_online"
  | "no_browser_connected"
  | "browser_disconnected"
  | "internal";

export interface RpcErrorData {
  /** Stable machine reason for hint selection (e.g. `ref_not_found`, `tab_not_controlled`). */
  reason?: string;
  /** Recovery hint for agents. */
  hint?: string;
  [key: string]: unknown;
}

export interface RpcError {
  code: ErrorCode;
  message: string;
  data?: RpcErrorData;
}

export interface RequestFrame<P = unknown> {
  id: RpcId;
  method: string;
  params?: P;
}
export interface OkResponseFrame<R = unknown> {
  id: RpcId;
  result: R;
}
export interface ErrResponseFrame {
  id: RpcId;
  error: RpcError;
}
export type ResponseFrame<R = unknown> = OkResponseFrame<R> | ErrResponseFrame;
export interface EventFrame<P = unknown> {
  event: string;
  payload?: P;
}
export type Frame = RequestFrame | ResponseFrame | EventFrame;

export function isRequestFrame(f: unknown): f is RequestFrame {
  return !!f && typeof f === "object" && typeof (f as RequestFrame).method === "string" && typeof (f as RequestFrame).id === "string";
}
export function isResponseFrame(f: unknown): f is ResponseFrame {
  return (
    !!f &&
    typeof f === "object" &&
    typeof (f as ResponseFrame).id === "string" &&
    !("method" in (f as object)) &&
    ("result" in (f as object) || "error" in (f as object))
  );
}
export function isEventFrame(f: unknown): f is EventFrame {
  return !!f && typeof f === "object" && typeof (f as EventFrame).event === "string" && !("id" in (f as object));
}
export function isErrResponse(f: ResponseFrame): f is ErrResponseFrame {
  return "error" in f;
}

export function rpcError(code: ErrorCode, message: string, data?: RpcErrorData): RpcError {
  return data ? { code, message, data } : { code, message };
}

export class RpcFailure extends Error {
  readonly error: RpcError;
  constructor(error: RpcError) {
    super(`${error.code}: ${error.message}`);
    this.name = "RpcFailure";
    this.error = error;
  }
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

/** Methods served by the daemon itself (CLI → daemon). */
export const DAEMON_METHODS = [
  "system.ping",
  "system.status",
  "system.shutdown",
  "browser.list",
  "session.start",
  "session.stop",
  "session.stop_all",
  "session.list",
  "tool.wait_ms",
] as const;

/** Methods the daemon forwards to the owning extension (CLI → daemon → extension). */
export const TOOL_METHODS = [
  "tool.session_start",
  "tool.session_stop",
  "tool.tab_list",
  "tool.tab_create",
  "tool.tab_close",
  "tool.tab_select",
  "tool.tab_borrow",
  "tool.tab_return",
  "tool.window_resize",
  "tool.navigate",
  "tool.navigate_back",
  "tool.navigate_forward",
  "tool.reload",
  "tool.snapshot",
  "tool.get_html",
  "tool.get_text",
  "tool.find",
  "tool.screenshot",
  "tool.click",
  "tool.hover",
  "tool.fill",
  "tool.type",
  "tool.press",
  "tool.select",
  "tool.check",
  "tool.scroll",
  "tool.scroll_to",
  "tool.evaluate",
  "tool.console",
  "tool.network",
  "tool.wait_for_element",
  "tool.wait_for_navigation",
  "tool.dialog_status",
  "tool.dialog_handle",
  "tool.cookies",
  "tool.pdf",
] as const;

export type DaemonMethod = (typeof DAEMON_METHODS)[number];
export type ToolMethod = (typeof TOOL_METHODS)[number];
export type Method = DaemonMethod | ToolMethod | "system.handshake" | "cancel";

export function isToolMethod(m: string): m is ToolMethod {
  return (TOOL_METHODS as readonly string[]).includes(m);
}

/** Effect class, used by the daemon to gate actions after a user pressed Stop in the Agent Window. */
export type MethodEffect = "read" | "mutate" | "control";

const READ_METHODS: ReadonlySet<string> = new Set([
  "tool.tab_list",
  "tool.snapshot",
  "tool.get_html",
  "tool.get_text",
  "tool.find",
  "tool.screenshot",
  "tool.console",
  "tool.network",
  "tool.wait_for_element",
  "tool.wait_for_navigation",
  "tool.dialog_status",
  "tool.cookies",
  "tool.pdf",
]);

export function methodEffect(method: string): MethodEffect {
  if (!method.startsWith("tool.")) return "control";
  if (method === "tool.session_start" || method === "tool.session_stop" || method === "tool.wait_ms") return "control";
  return READ_METHODS.has(method) ? "read" : "mutate";
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventKind =
  | "system.heartbeat"
  | "browser.connected"
  | "browser.disconnected"
  | "session.window_closed"
  | "session.user_interrupt"
  | "session.activity"
  | "dialog.changed";

// ---------------------------------------------------------------------------
// Handshake (extension → daemon, first frame on the WebSocket)
// ---------------------------------------------------------------------------

export interface BrowserMeta {
  /** Detected vendor id: chrome | edge | whale | brave | arc | dia | opera | vivaldi | yandex | chromium */
  name: string;
  /** Chromium/vendor version string. */
  version: string;
  /** Chromium major version, when known. */
  chromium?: string;
  /** How `name` was decided: ua | brands | api | process | label */
  detected_by?: string;
}

export interface HandshakeParams {
  client: string;
  version: string;
  protocol_version: string;
  /** Random id persisted in extension storage; stable per browser profile. */
  instance_id: string;
  browser: BrowserMeta;
  /** User-chosen label from the popup (e.g. "work-chrome"). */
  label: string;
}

export interface HandshakeResult {
  server: string;
  version: string;
  protocol_version: string;
  /** Daemon-side process identity of the peer (macOS/Linux: from lsof), when resolved. */
  process?: ProcessIdentity;
}

export interface ProcessIdentity {
  pid: number;
  /** Executable/app name, e.g. "Google Chrome", "Arc", "Dia", "Whale", "Brave Browser", "Microsoft Edge". */
  name: string;
  /** Normalised vendor id derived from `name`. */
  browser?: string;
  path?: string;
}

// ---------------------------------------------------------------------------
// Daemon status / browsers / sessions
// ---------------------------------------------------------------------------

export interface BrowserEntry {
  instance_id: string;
  label: string;
  browser: BrowserMeta;
  extension_version: string;
  protocol_version: string;
  process?: ProcessIdentity;
  connected_at: string;
  sessions: number;
}

export interface SessionEntry {
  session_id: string;
  browser_instance_id: string;
  browser_name: string;
  created_at: string;
  last_activity_at: string;
  agent_window_id?: number;
  active_tab_id?: number;
  interrupted?: boolean;
  controller?: ControllerInfo;
}

export interface StatusResult {
  daemon_version: string;
  protocol_version: string;
  pid: number;
  uptime_secs: number;
  ws_port: number;
  sock_path: string;
  home: string;
  browsers: BrowserEntry[];
  sessions: SessionEntry[];
}

export interface BrowserListResult {
  browsers: BrowserEntry[];
}

export interface ControllerInfo {
  name: string;
  project?: string;
}

export interface SessionStartParams {
  /** Select a browser by instance id or unique label; required when >1 browser is connected. */
  browser?: string;
  focused?: boolean;
  width?: number;
  height?: number;
  incognito?: boolean;
  controller?: ControllerInfo;
}
export interface SessionStartResult {
  session_id: string;
  browser_instance_id: string;
  browser: BrowserMeta;
  agent_window_id?: number;
  active_tab_id?: number;
}
export interface SessionStopParams {
  session_id: string;
}
export interface SessionStopResult {
  session_id: string;
  returned_tabs: number[];
  closed_tabs: number[];
}
export interface SessionListResult {
  sessions: SessionEntry[];
}

export interface WaitMsParams {
  ms: number;
}
export interface WaitMsResult {
  waited_ms: number;
}

// ---------------------------------------------------------------------------
// Tool params/results (daemon → extension). Every tool carries `session_id`.
// ---------------------------------------------------------------------------

export interface SessionScoped {
  session_id: string;
}
export interface TabScoped extends SessionScoped {
  /** Target tab; defaults to the session's active tab. */
  tab_id?: number;
}

export interface ToolSessionStartParams extends SessionScoped {
  focused?: boolean;
  width?: number;
  height?: number;
  incognito?: boolean;
  controller?: ControllerInfo;
}
export interface ToolSessionStartResult {
  agent_window_id: number;
  active_tab_id: number;
}
export interface ToolSessionStopResult {
  returned_tabs: number[];
  closed_tabs: number[];
}

export type TabScope = "user" | "agent" | "all";
export interface TabInfo {
  tab_id: number;
  window_id: number;
  title?: string;
  url?: string;
  active?: boolean;
  scope: "user" | "agent";
  borrowed?: boolean;
}
export interface TabListParams extends SessionScoped {
  scope?: TabScope;
}
export interface TabListResult {
  tabs: TabInfo[];
  active_tab_id?: number;
}
export interface TabCreateParams extends SessionScoped {
  url?: string;
  active?: boolean;
}
export interface TabCreateResult {
  tab_id: number;
}
export interface TabIdParams extends SessionScoped {
  tab_id: number;
}
export interface TabBorrowResult {
  tab_id: number;
  from_window_id: number;
  title?: string;
  url?: string;
}
export interface TabReturnResult {
  tab_id: number;
  window_id: number;
}
export interface WindowResizeParams extends SessionScoped {
  width: number;
  height: number;
}

export interface NavigateParams extends TabScoped {
  url: string;
  /** Wait condition after navigation. Default `load`. */
  wait_until?: "none" | "load" | "domcontentloaded";
  timeout_ms?: number;
}
export interface NavigateResult {
  tab_id: number;
  url: string;
  title?: string;
  status: "complete" | "timeout";
}
export type HistoryParams = TabScoped & { timeout_ms?: number };

export interface SnapshotParams extends TabScoped {
  /** `interactive` (default): clickable/typable + headings/landmarks. `full`: every visible text node. */
  mode?: "interactive" | "full";
  max_chars?: number;
  /** Restrict to the subtree of a ref or CSS selector. */
  root?: string;
}
export interface SnapshotResult {
  tab_id: number;
  url: string;
  title: string;
  /** Observation id; refs are valid for this document until navigation. */
  observation_id: string;
  text: string;
  ref_count: number;
  truncated: boolean;
  dialog?: DialogInfo;
}

export interface GetHtmlParams extends TabScoped {
  /** Ref or CSS selector; defaults to the document element. */
  target?: string;
  outer?: boolean;
  max_chars?: number;
}
export interface GetHtmlResult {
  tab_id: number;
  html: string;
  truncated: boolean;
}
export interface GetTextParams extends TabScoped {
  target?: string;
  max_chars?: number;
}
export interface GetTextResult {
  tab_id: number;
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}
export interface FindParams extends TabScoped {
  /** Case-insensitive substring over role/name/text. */
  query: string;
  limit?: number;
}
export interface FindResult {
  tab_id: number;
  observation_id: string;
  matches: Array<{ ref: string; role: string; name: string; text?: string }>;
}

export interface ScreenshotParams extends TabScoped {
  /** Ref or CSS selector to clip to. */
  target?: string;
  full_page?: boolean;
  format?: "png" | "jpeg";
  quality?: number;
}
export interface ScreenshotResult {
  tab_id: number;
  format: "png" | "jpeg";
  width: number;
  height: number;
  /** Base64 image bytes. */
  data: string;
  /** How the capture was taken: cdp | tabs_api */
  via: string;
}

export type MouseButton = "left" | "right" | "middle";
export type KeyModifier = "alt" | "ctrl" | "meta" | "shift";

export interface TargetParams extends TabScoped {
  /** `@e12` ref from snapshot, or a CSS selector. */
  target: string;
}
export interface ClickParams extends TargetParams {
  button?: MouseButton;
  click_count?: number;
  modifiers?: KeyModifier[];
  /** Skip the trusted CDP path and dispatch DOM events only. */
  dom?: boolean;
}
export interface ActionResult {
  tab_id: number;
  target: string;
  /** `cdp` (trusted input) or `dom` (synthetic events). */
  via: "cdp" | "dom";
  /** URL after the action, when it changed. */
  navigated_to?: string;
  dialog?: DialogInfo;
}
export interface FillParams extends TargetParams {
  value: string;
  /** Submit with Enter after filling. */
  submit?: boolean;
}
export interface TypeParams extends TabScoped {
  text: string;
  delay_ms?: number;
}
export interface PressParams extends TabScoped {
  /** Key combo such as `Enter`, `Control+a`, `Shift+Tab`, `ArrowDown`. */
  key: string;
  target?: string;
}
export interface SelectParams extends TargetParams {
  values: string[];
}
export interface SelectResult extends ActionResult {
  selected: string[];
}
export interface CheckParams extends TargetParams {
  checked: boolean;
}
export interface ScrollParams extends TabScoped {
  target?: string;
  delta_x?: number;
  delta_y?: number;
  /** Scroll to an absolute position instead. */
  to?: "top" | "bottom";
}
export interface ScrollResult {
  tab_id: number;
  scroll_x: number;
  scroll_y: number;
  at_bottom: boolean;
}

export interface EvaluateParams extends TabScoped {
  expression: string;
  /** Run in the page's MAIN world (default) or the extension's ISOLATED world. */
  world?: "main" | "isolated";
  timeout_ms?: number;
}
export interface EvaluateResult {
  tab_id: number;
  value: unknown;
  type: string;
}

export interface ConsoleEntry {
  seq: number;
  ts: number;
  level: string;
  text: string;
  url?: string;
  line?: number;
}
export interface ConsoleParams extends TabScoped {
  since_seq?: number;
  level?: string;
  limit?: number;
  clear?: boolean;
}
export interface ConsoleResult {
  tab_id: number;
  entries: ConsoleEntry[];
  capturing: boolean;
}
export interface NetworkEntry {
  seq: number;
  ts: number;
  request_id: string;
  method: string;
  url: string;
  status?: number;
  mime?: string;
  resource_type?: string;
  failed?: string;
  duration_ms?: number;
}
export interface NetworkParams extends TabScoped {
  since_seq?: number;
  filter?: string;
  limit?: number;
  clear?: boolean;
  /** Fetch the response body for one request id. */
  body_for?: string;
}
export interface NetworkResult {
  tab_id: number;
  entries: NetworkEntry[];
  capturing: boolean;
  body?: { request_id: string; base64: boolean; body: string; truncated: boolean };
}

export interface WaitForElementParams extends TabScoped {
  target: string;
  state?: "visible" | "hidden" | "attached" | "detached";
  timeout_ms?: number;
}
export interface WaitForElementResult {
  tab_id: number;
  matched: boolean;
  elapsed_ms: number;
}
export interface WaitForNavigationParams extends TabScoped {
  /** Wait until the URL matches this substring/regex (optional). */
  url_includes?: string;
  wait_until?: "load" | "domcontentloaded";
  timeout_ms?: number;
}
export interface WaitForNavigationResult {
  tab_id: number;
  url: string;
  reached: "load" | "domcontentloaded" | "timeout";
}

export type DialogType = "alert" | "confirm" | "prompt" | "beforeunload";
export interface DialogInfo {
  tab_id: number;
  type: DialogType;
  message: string;
  default_prompt?: string;
  url?: string;
  opened_at: number;
}
export interface DialogStatusResult {
  tab_id: number;
  dialog?: DialogInfo;
}
export interface DialogHandleParams extends TabScoped {
  accept: boolean;
  text?: string;
}
export interface DialogHandleResult {
  tab_id: number;
  handled: boolean;
}

export interface CookiesParams extends TabScoped {
  /** Only metadata is ever returned; values are redacted. */
  domain?: string;
}
export interface CookiesResult {
  tab_id: number;
  cookies: Array<{ name: string; domain: string; path: string; secure: boolean; http_only: boolean; expires?: number }>;
}
export interface PdfParams extends TabScoped {
  landscape?: boolean;
}
export interface PdfResult {
  tab_id: number;
  data: string;
}

// ---------------------------------------------------------------------------
// Browser identity helpers (shared by extension UA parsing and daemon process lookup)
// ---------------------------------------------------------------------------

export const KNOWN_BROWSERS = [
  "chrome",
  "edge",
  "whale",
  "brave",
  "arc",
  "dia",
  "opera",
  "vivaldi",
  "yandex",
  "samsung",
  "chromium",
] as const;
export type KnownBrowser = (typeof KNOWN_BROWSERS)[number];

/** Map a process/app name (from lsof, ps, tasklist) to a vendor id. */
export function browserFromProcessName(name: string): KnownBrowser | undefined {
  const n = name.toLowerCase();
  if (n.includes("google chrome") || n === "chrome" || n.startsWith("chrome ")) return "chrome";
  if (n.includes("microsoft edge") || n.includes("msedge")) return "edge";
  if (n.includes("whale")) return "whale";
  if (n.includes("brave")) return "brave";
  if (n === "arc" || n.startsWith("arc ") || n.includes("arc helper") || n.includes("/arc.app/")) return "arc";
  if (n === "dia" || n.startsWith("dia ") || n.includes("dia helper") || n.includes("/dia.app/")) return "dia";
  if (n.includes("opera")) return "opera";
  if (n.includes("vivaldi")) return "vivaldi";
  if (n.includes("yandex")) return "yandex";
  if (n.includes("chromium")) return "chromium";
  return undefined;
}

/** Best-effort vendor detection from a user agent string and (optionally) UA-CH brands. */
export function browserFromUserAgent(ua: string, brands: string[] = []): BrowserMeta {
  const chromium = /Chrome\/(\d+)/.exec(ua)?.[1];
  const b = brands.map((s) => s.toLowerCase());
  const probes: Array<[RegExp, KnownBrowser]> = [
    [/Whale\/([0-9.]+)/, "whale"],
    [/Edg\/([0-9.]+)/, "edge"],
    [/OPR\/([0-9.]+)/, "opera"],
    [/Vivaldi\/([0-9.]+)/, "vivaldi"],
    [/YaBrowser\/([0-9.]+)/, "yandex"],
    [/SamsungBrowser\/([0-9.]+)/, "samsung"],
    [/Brave\/([0-9.]+)/, "brave"],
  ];
  for (const [re, name] of probes) {
    const m = re.exec(ua);
    if (m) return { name, version: m[1] ?? "", chromium, detected_by: "ua" };
  }
  for (const [needle, name] of [
    ["microsoft edge", "edge"],
    ["brave", "brave"],
    ["opera", "opera"],
    ["vivaldi", "vivaldi"],
    ["whale", "whale"],
    ["google chrome", "chrome"],
  ] as Array<[string, KnownBrowser]>) {
    if (b.some((x) => x.includes(needle))) return { name, version: chromium ?? "", chromium, detected_by: "brands" };
  }
  if (chromium) return { name: "chrome", version: chromium, chromium, detected_by: "ua" };
  return { name: "chromium", version: "unknown", detected_by: "ua" };
}

export function compareProtocol(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function protocolCompatible(peer: string): boolean {
  const [major] = peer.split(".");
  return major === PROTOCOL_VERSION.split(".")[0];
}

/** Normalise `@e12` / `e12` / `12` → `e12`. Returns null for non-ref targets (CSS selectors). */
export function parseRef(target: string): string | null {
  const m = /^@?e(\d+)$/.exec(target.trim());
  return m ? `e${m[1]}` : null;
}
