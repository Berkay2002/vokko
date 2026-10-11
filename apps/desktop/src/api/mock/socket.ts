// Mock gateway: speaks the same Hello / Identify / READY / heartbeat / Resume protocol as the real server so the
// client gateway code (and everything above it) cannot tell the difference.

import { GatewayOp, type GatewayEvents, type GatewayPayload, type PresenceStatus, type VoiceStateUpdateCommand } from "../types";
import { db } from "./db";
import { readyFor } from "./views";
import { handleVoiceStateUpdate } from "./voice";

const HEARTBEAT_MS = 41_250;
const BUFFER = 500;

interface Session {
  id: string;
  userId: string;
  seq: number;
  buffer: GatewayPayload[];
  socket: MockSocket | null;
}

const sessions = new Map<string, Session>();
let sessionCounter = 0;

export function userIdFromToken(token: string | null): string | null {
  if (!token?.startsWith("mock:")) return null;
  const id = token.slice(5);
  return db.accounts.has(id) ? id : null;
}

export function tokenFor(userId: string): string {
  return `mock:${userId}`;
}

/** Deliver a dispatch to every session of the given users (buffered for resume). */
export function emit<K extends keyof GatewayEvents>(userIds: Iterable<string>, t: K, d: GatewayEvents[K]): void {
  const wanted = new Set(userIds);
  // After the REST response has been delivered, like a real server.
  setTimeout(() => {
    for (const session of sessions.values()) {
      if (!wanted.has(session.userId)) continue;
      session.seq += 1;
      const payload: GatewayPayload = { op: GatewayOp.Dispatch, d, s: session.seq, t };
      session.buffer.push(payload);
      if (session.buffer.length > BUFFER) session.buffer.shift();
      session.socket?.deliver(payload);
    }
  }, 0);
}

/** Deliver a dispatch to one gateway session only (VOICE_SERVER_UPDATE, VOICE_CONNECT_FAILED). */
export function emitToSession<K extends keyof GatewayEvents>(sessionId: string, t: K, d: GatewayEvents[K]): void {
  setTimeout(() => {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.seq += 1;
    const payload: GatewayPayload = { op: GatewayOp.Dispatch, d, s: session.seq, t };
    session.buffer.push(payload);
    if (session.buffer.length > BUFFER) session.buffer.shift();
    session.socket?.deliver(payload);
  }, 0);
}

export function emitToAll<K extends keyof GatewayEvents>(t: K, d: GatewayEvents[K]): void {
  const users = new Set([...sessions.values()].map(s => s.userId));
  emit(users, t, d);
}

export function onlineUserIds(): Set<string> {
  return new Set([...sessions.values()].filter(s => s.socket).map(s => s.userId));
}

/** Test hook: abruptly drop every open mock connection (the client should resume). */
export function dropAllConnections(code = 1006): void {
  for (const session of sessions.values()) session.socket?.drop(code);
}

let refusing = false;

/** Test hook: while true every new connection is refused (closed with 1006) and open ones are dropped, like a dead network. */
export function setOffline(offline: boolean): void {
  refusing = offline;
  if (offline) dropAllConnections();
}

export class MockSocket {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readyState = 0;
  private session: Session | null = null;

  constructor() {
    setTimeout(() => {
      if (this.readyState !== 0) return;
      if (refusing) {
        this.readyState = 3;
        this.onclose?.({ code: 1006 });
        return;
      }
      this.readyState = 1;
      this.onopen?.({});
      this.out({ op: GatewayOp.Hello, d: { heartbeat_interval: HEARTBEAT_MS }, s: null, t: null });
    }, 15);
  }

  send(data: string): void {
    if (this.readyState !== 1) return;
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(data) as GatewayPayload;
    } catch {
      return;
    }
    switch (payload.op) {
      case GatewayOp.Heartbeat:
        this.out({ op: GatewayOp.HeartbeatAck, d: null, s: null, t: null });
        break;
      case GatewayOp.Identify:
        this.identify((payload.d as { token?: string } | null)?.token ?? null);
        break;
      case GatewayOp.Resume:
        this.resume(payload.d as { token?: string; session_id?: string; seq?: number });
        break;
      case GatewayOp.PresenceUpdate:
        this.presence(payload.d as { status: PresenceStatus; custom_status?: string | null });
        break;
      case GatewayOp.VoiceStateUpdate:
        if (this.session) handleVoiceStateUpdate(this.session.id, this.session.userId, payload.d as VoiceStateUpdateCommand, emit, emitToSession);
        break;
      default:
        break;
    }
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.session?.socket === this) {
      this.session.socket = null;
      this.sync(this.session.userId);
    }
    setTimeout(() => this.onclose?.({ code }), 0);
  }

  /** Server-side abrupt close. */
  drop(code: number): void {
    this.close(code);
  }

  deliver(payload: GatewayPayload): void {
    if (this.readyState === 1) this.out(payload);
  }

  private out(payload: GatewayPayload): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  private identify(token: string | null): void {
    const userId = userIdFromToken(token);
    if (!userId) {
      this.close(4004);
      return;
    }
    const session: Session = { id: `mock-session-${(sessionCounter += 1)}`, userId, seq: 0, buffer: [], socket: this };
    sessions.set(session.id, session);
    this.session = session;
    session.seq += 1;
    this.out({ op: GatewayOp.Dispatch, d: readyFor(userId, session.id), s: session.seq, t: "READY" });
    this.sync(userId);
  }

  private resume(d: { token?: string; session_id?: string; seq?: number }): void {
    const userId = userIdFromToken(d.token ?? null);
    if (!userId) {
      this.close(4004);
      return;
    }
    const session = d.session_id ? sessions.get(d.session_id) : undefined;
    const seq = d.seq ?? 0;
    const oldest = session?.buffer[0]?.s ?? session?.seq ?? 0;
    if (!session || session.userId !== userId || seq < oldest - 1) {
      this.out({ op: GatewayOp.InvalidSession, d: false, s: null, t: null });
      return;
    }
    session.socket = this;
    this.session = session;
    for (const payload of session.buffer) if ((payload.s ?? 0) > seq) this.out(payload);
    this.out({ op: GatewayOp.Dispatch, d: {}, s: null, t: "RESUMED" });
    this.sync(userId);
  }

  private presence(d: { status: PresenceStatus; custom_status?: string | null }): void {
    if (!this.session) return;
    const account = db.accounts.get(this.session.userId);
    if (!account) return;
    account.presence = { user_id: account.user.id, status: d.status, custom_status: d.custom_status ?? null };
    emitToAll("PRESENCE_UPDATE", { ...account.presence });
  }

  /** Presence follows connectivity: first connection → online (unless set otherwise), last closed → offline. */
  private sync(userId: string): void {
    const account = db.accounts.get(userId);
    if (!account) return;
    const online = onlineUserIds().has(userId);
    if (online && account.presence.status === "offline") account.presence = { ...account.presence, status: "online" };
    if (!online && account.presence.status !== "offline") account.presence = { ...account.presence, status: "offline" };
    emitToAll("PRESENCE_UPDATE", { ...account.presence });
  }
}
