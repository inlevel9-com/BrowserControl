// WebSocket transport to the local bctl daemon. Pure byte pipe: one send() = one frame.
// Reconnects with capped exponential backoff; the handshake lives in background.ts.
import type { Frame } from "@browser-control/protocol";

export type ConnectionState = "disconnected" | "connecting" | "connected";

type Listener<T> = (v: T) => void;

export class WsTransport {
  private ws: WebSocket | null = null;
  private url: string;
  private _state: ConnectionState = "disconnected";
  private messageListeners = new Set<Listener<Frame>>();
  private stateListeners = new Set<Listener<ConnectionState>>();
  private openListeners = new Set<() => void>();
  private backoffMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wantOpen = false;
  private lastError: string | null = null;

  constructor(url: string) {
    this.url = url;
  }

  get state(): ConnectionState {
    return this._state;
  }
  get error(): string | null {
    return this.lastError;
  }

  setUrl(url: string): void {
    if (url === this.url) return;
    this.url = url;
    if (this.wantOpen) {
      this.closeSocket();
      this.connect();
    }
  }

  connect(): void {
    this.wantOpen = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.clearTimer();
    this.setState("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.lastError = String(e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.backoffMs = 1000;
      this.lastError = null;
      this.setState("connected");
      for (const l of this.openListeners) l();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let frame: Frame;
      try {
        frame = JSON.parse(typeof ev.data === "string" ? ev.data : "") as Frame;
      } catch {
        return; // drop malformed frames silently
      }
      for (const l of this.messageListeners) l(frame);
    };
    ws.onerror = () => {
      this.lastError = `cannot reach ${this.url}`;
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.reason) this.lastError = ev.reason;
      this.setState("disconnected");
      if (this.wantOpen) this.scheduleReconnect();
    };
  }

  disconnect(): void {
    this.wantOpen = false;
    this.clearTimer();
    this.closeSocket();
    this.setState("disconnected");
  }

  send(frame: Frame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("transport not connected");
    this.ws.send(JSON.stringify(frame));
  }

  onMessage(l: Listener<Frame>): () => void {
    this.messageListeners.add(l);
    return () => this.messageListeners.delete(l);
  }
  onStateChange(l: Listener<ConnectionState>): () => void {
    this.stateListeners.add(l);
    return () => this.stateListeners.delete(l);
  }
  onOpen(l: () => void): () => void {
    this.openListeners.add(l);
    return () => this.openListeners.delete(l);
  }

  /** Called from an alarm: if we should be open but are not, try now. */
  poke(): void {
    if (this.wantOpen && (!this.ws || this.ws.readyState === WebSocket.CLOSED)) {
      this.clearTimer();
      this.connect();
    }
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }
  private scheduleReconnect(): void {
    this.clearTimer();
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
  private clearTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
  private setState(s: ConnectionState): void {
    if (this._state === s) return;
    this._state = s;
    for (const l of this.stateListeners) l(s);
  }
}
