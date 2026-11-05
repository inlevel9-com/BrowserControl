// Persistent per-profile instance id, user label, port, enabled flag, and browser detection.
import { browserFromUserAgent, type BrowserMeta, DEFAULT_WS_PORT } from "@browser-control/protocol";

declare const __BCTL_DAEMON_WS_URL__: string;
declare const __BCTL_EXT_VERSION__: string;

export const EXTENSION_VERSION: string = typeof __BCTL_EXT_VERSION__ === "string" ? __BCTL_EXT_VERSION__ : "0.0.0";
const BASE_WS = new URL(typeof __BCTL_DAEMON_WS_URL__ === "string" ? __BCTL_DAEMON_WS_URL__ : `ws://127.0.0.1:${DEFAULT_WS_PORT}`);

export interface Settings {
  instanceId: string;
  label: string;
  port: number;
  enabled: boolean;
}

export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(["instanceId", "label", "port", "enabled"]);
  let instanceId = typeof got.instanceId === "string" ? got.instanceId : "";
  if (!instanceId) {
    instanceId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    await chrome.storage.local.set({ instanceId });
  }
  const port = Number.isInteger(got.port) && got.port > 0 && got.port < 65536 ? (got.port as number) : Number(BASE_WS.port) || DEFAULT_WS_PORT;
  return {
    instanceId,
    label: typeof got.label === "string" ? got.label : "",
    port,
    enabled: got.enabled !== false,
  };
}

export function wsUrlForPort(port: number): string {
  return `${BASE_WS.protocol}//${BASE_WS.hostname}:${port}${BASE_WS.pathname === "/" ? "" : BASE_WS.pathname}`;
}

interface NavigatorUAData {
  brands?: Array<{ brand: string; version: string }>;
}

/** Vendor detection inside the extension. Arc and Dia expose no UA token; the daemon
 *  resolves them from the peer process, and the popup label is the final override. */
export async function detectBrowser(): Promise<BrowserMeta> {
  const uaData = (navigator as unknown as { userAgentData?: NavigatorUAData }).userAgentData;
  const brands = uaData?.brands?.map((b) => b.brand) ?? [];
  const meta = browserFromUserAgent(navigator.userAgent, brands);
  const brave = (navigator as unknown as { brave?: { isBrave?: () => Promise<boolean> } }).brave;
  if (brave?.isBrave) {
    try {
      if (await brave.isBrave()) return { ...meta, name: "brave", detected_by: "api" };
    } catch {
      /* ignore */
    }
  }
  return meta;
}
