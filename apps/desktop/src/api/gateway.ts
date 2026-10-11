import { GATEWAY_URL, MOCK } from "./config";
import { MockSocket } from "./mock";
import { GatewayOp, type GatewayEvents, type GatewayPayload, type VoiceStateUpdateCommand } from "./types";

export type GatewayStatus = "disconnected" | "connecting" | "ready" | "reconnecting";

/** Close code the server uses for a bad token: stop reconnecting and drop the session. */
export const CLOSE_AUTH_FAILED = 4004;
/** Close code for sockets the client itself drops (zombie connection, Hello timeout, teardown); the session stays resumable. */
const CLOSE_CLIENT = 4000;
/** Hello must arrive this soon after the socket opens. */
const HELLO_TIMEOUT_MS = 30_000;
/** A session is resumed only if the last heartbeat ACK is younger than this; otherwise the client identifies again. */
const RESUME_WINDOW_MS = 3 * 60_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

interface Socket {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
}

type Listener = (d: never) => void;

class GatewayClient {
  private socket: Socket | null = null;
  private token: string | null = null;
  private wanted = false;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private heartbeatKickoff: ReturnType<typeof setTimeout> | null = null;
  private ackPending = false;
  private lastAckAt = 0;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private current: GatewayStatus = "disconnected";
  private listeners = new Map<string, Set<Listener>>();
  private statusListeners = new Set<(status: GatewayStatus) => void>();
  private authFailedListeners = new Set<() => void>();

  constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        if (this.wanted && !this.socket) this.open();
      });
    }
  }

  get status(): GatewayStatus {
    return this.current;
  }

  /** Idempotent: calling again with the same token while connected/connecting is a no-op. */
  connect(token: string): void {
    if (this.wanted && this.token === token && (this.socket || this.reconnectTimer)) return;
    this.teardown();
    this.token = token;
    this.wanted = true;
    this.seq = null;
    this.sessionId = null;
    this.attempts = 0;
    this.open();
  }

  /** "Reconnect now" on the connection banner / splash: drop the current attempt (or its backoff wait) and open a socket immediately. */
  retryNow(): void {
    if (!this.wanted || this.current === "ready") return;
    this.teardown();
    this.open();
  }

  disconnect(): void {
    this.wanted = false;
    this.teardown();
    this.token = null;
    this.seq = null;
    this.sessionId = null;
    this.setStatus("disconnected");
  }

  send(op: GatewayOp, d: unknown): void {
    if (this.socket && this.socket.readyState === 1) {
      const frame: GatewayPayload = { op, d, s: null, t: null };
      this.socket.send(JSON.stringify(frame));
    }
  }

  /** op 4: join, move, leave (`channel_id: null`) or toggle self mute/deafen. Dropped while the socket is down (re-sent after READY). */
  sendVoiceStateUpdate(command: VoiceStateUpdateCommand): void {
    this.send(GatewayOp.VoiceStateUpdate, command);
  }

  on<K extends keyof GatewayEvents>(t: K, fn: (d: GatewayEvents[K]) => void): () => void {
    let set = this.listeners.get(t);
    if (!set) this.listeners.set(t, (set = new Set()));
    const bucket = set;
    bucket.add(fn as Listener);
    return () => {
      bucket.delete(fn as Listener);
    };
  }

  /** Calls `fn` immediately with the current status, then on every change. */
  onStatus(fn: (status: GatewayStatus) => void): () => void {
    this.statusListeners.add(fn);
    fn(this.current);
    return () => {
      this.statusListeners.delete(fn);
    };
  }

  /** Fired when the server rejects the token (close 4004). The auth module clears the stored token. */
  onAuthFailed(fn: () => void): () => void {
    this.authFailedListeners.add(fn);
    return () => {
      this.authFailedListeners.delete(fn);
    };
  }

  private setStatus(status: GatewayStatus): void {
    if (this.current === status) return;
    this.current = status;
    for (const fn of [...this.statusListeners]) fn(status);
  }

  private open(): void {
    if (!this.wanted) return;
    this.setStatus(this.sessionId || this.attempts > 0 ? "reconnecting" : "connecting");
    const socket: Socket = MOCK ? new MockSocket() : (new WebSocket(GATEWAY_URL) as unknown as Socket);
    this.socket = socket;
    this.helloTimer = setTimeout(() => {
      this.helloTimer = null;
      if (this.socket === socket) socket.close(CLOSE_CLIENT);
    }, HELLO_TIMEOUT_MS);
    socket.onmessage = event => {
      if (this.socket === socket) this.handle(event.data);
    };
    socket.onclose = event => {
      if (this.socket === socket) this.closed(event.code);
    };
    socket.onerror = () => {
      /* always followed by onclose */
    };
  }

  private handle(raw: unknown): void {
    if (typeof raw !== "string") return;
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(raw) as GatewayPayload;
    } catch {
      return;
    }
    if (payload.s != null) this.seq = payload.s;
    switch (payload.op) {
      case GatewayOp.Hello: {
        this.clearHelloTimer();
        const interval = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
        this.startHeartbeat(interval);
        const fresh = Date.now() - this.lastAckAt < RESUME_WINDOW_MS;
        if (this.sessionId && this.seq != null && fresh) this.send(GatewayOp.Resume, { token: this.token, session_id: this.sessionId, seq: this.seq });
        else {
          this.sessionId = null;
          this.seq = null;
          this.send(GatewayOp.Identify, { token: this.token });
        }
        break;
      }
      case GatewayOp.Heartbeat:
        this.beat();
        break;
      case GatewayOp.HeartbeatAck:
        this.ackPending = false;
        this.lastAckAt = Date.now();
        break;
      case GatewayOp.Reconnect:
        this.socket?.close(CLOSE_CLIENT);
        break;
      case GatewayOp.InvalidSession:
        this.sessionId = null;
        this.seq = null;
        setTimeout(() => this.send(GatewayOp.Identify, { token: this.token }), 250 + Math.random() * 500);
        break;
      case GatewayOp.Dispatch:
        this.dispatch(payload.t, payload.d);
        break;
      default:
        break;
    }
  }

  private dispatch(t: string | null, d: unknown): void {
    if (!t) return;
    if (t === "READY") this.sessionId = (d as { session_id: string }).session_id;
    if (t === "READY" || t === "RESUMED") {
      this.attempts = 0;
      this.setStatus("ready");
    }
    const set = this.listeners.get(t);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (d: unknown) => void)(d);
      } catch (error) {
        console.error(`gateway listener for ${t} threw`, error);
      }
    }
  }

  private clearHelloTimer(): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
  }

  private startHeartbeat(interval: number): void {
    this.stopHeartbeat();
    this.ackPending = false;
    // The connection was just proven alive by Hello; count it as the last ACK until the first real one arrives.
    this.lastAckAt = Date.now();
    this.heartbeatKickoff = setTimeout(() => {
      this.beat();
      this.heartbeat = setInterval(() => this.beat(), interval);
    }, interval * Math.random());
  }

  private beat(): void {
    if (this.ackPending) {
      // The previous heartbeat was never acknowledged: the connection is a zombie.
      this.socket?.close(CLOSE_CLIENT);
      return;
    }
    this.ackPending = true;
    this.send(GatewayOp.Heartbeat, this.seq);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.heartbeatKickoff) clearTimeout(this.heartbeatKickoff);
    this.heartbeat = null;
    this.heartbeatKickoff = null;
  }

  private teardown(): void {
    this.stopHeartbeat();
    this.clearHelloTimer();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onmessage = socket.onclose = socket.onerror = socket.onopen = null;
      try {
        socket.close(CLOSE_CLIENT);
      } catch {
        /* already closed */
      }
    }
  }

  private closed(code: number): void {
    this.stopHeartbeat();
    this.clearHelloTimer();
    this.socket = null;
    if (code === CLOSE_AUTH_FAILED) {
      this.wanted = false;
      this.sessionId = null;
      this.seq = null;
      this.setStatus("disconnected");
      for (const fn of [...this.authFailedListeners]) fn();
      return;
    }
    if (!this.wanted) {
      this.setStatus("disconnected");
      return;
    }
    this.setStatus("reconnecting");
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempts) * (0.75 + Math.random() * 0.5);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }
}

export const gateway = new GatewayClient();
