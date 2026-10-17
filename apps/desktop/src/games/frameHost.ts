// The host side of the games SDK (docs/design/games-host.md sections 6 and 7). A game frame says hello on `window`; the host
// accepts it only from that frame's window and its expected origin, then hands over one MessagePort. Everything after that
// flows on the port and is parsed here; anything else is dropped. Nothing on the port carries tokens or Vokko ids.

import { API_ORIGIN, MOCK } from "../api/config";
import { GAME_RELAY_MAX_BYTES, type GameManifest, type GamePlayer } from "../api/types";
import { builtinGame, isBuiltin } from "./builtin";

/** Built-ins load from the app bundle without allow-same-origin, so their origin is opaque ("null"), never the app's. */
export const SANDBOX_BUILTIN = "allow-scripts allow-pointer-lock";
/** Third-party games keep their own https origin; the same-origin policy keeps them out of the app. */
export const SANDBOX_THIRD_PARTY = "allow-scripts allow-same-origin allow-pointer-lock";

export const PROTOCOL_VERSION = 1;

export type Player = { app_id: string; name: string; avatar: Blob | null };

export type HostToGame =
  | { type: "init"; game_id: string; me: Player; players: Player[]; leader: string }
  | { type: "players"; players: Player[]; leader: string }
  | { type: "message"; from: string; data: unknown }
  | { type: "error"; code: GameErrorCode }
  | { type: "close" };

export type GameErrorCode = "rate_limited" | "too_large" | "invalid" | "not_running";

export type GameToHost = { type: "ready" } | { type: "send"; data: unknown; to?: string } | { type: "close" } | { type: "escape" };

/** The origins a third-party game must not share (it would get allow-same-origin there). */
export function appOrigins(): string[] {
  return [globalThis.location?.origin ?? "", API_ORIGIN].filter(Boolean);
}

/** Where the frame loads: built-ins from this app's bundle (the server's URL for them is ignored), others from the manifest. */
export function frameUrl(game: GameManifest, base = globalThis.location?.origin ?? "http://localhost"): string {
  return isBuiltin(game) ? new URL(builtinGame(game.id)?.url ?? `/games/${game.id.slice("builtin:".length)}/index.html`, base).href : game.url;
}

/** The origin hellos must come from: "null" for a built-in (opaque), the manifest URL's origin otherwise. */
export function frameOrigin(game: GameManifest): string {
  if (isBuiltin(game)) return "null";
  try {
    return new URL(game.url).origin;
  } catch {
    return "";
  }
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

const bareHost = (host: string) => host.replace(/\.$/, "");

/**
 * The sandbox for `game`, or null when it must not be framed: a third-party URL that is not https (local http only for
 * dev and mock builds), or whose host is the app's or the API's on any port, trailing dot ignored (allow-same-origin
 * there would hand it the app; mirrors the server's own-origin rule).
 */
export function sandboxFor(game: GameManifest, app: string[] = appOrigins(), allowLoopback: boolean = import.meta.env.DEV || MOCK): string | null {
  if (isBuiltin(game)) return SANDBOX_BUILTIN;
  let url: URL;
  try {
    url = new URL(game.url);
  } catch {
    return null;
  }
  const host = bareHost(url.hostname);
  if (url.protocol !== "https:" && !(allowLoopback && url.protocol === "http:" && LOCAL_HOSTS.has(host))) return null;
  if (url.username || url.password) return null;
  const appHosts = app.flatMap(o => {
    try {
      return [bareHost(new URL(o).hostname)];
    } catch {
      return [];
    }
  });
  return appHosts.includes(host) ? null : SANDBOX_THIRD_PARTY;
}

/** The game's hello: from `frame`'s window, from `origin`, the exact shape. Anything else is not one. */
export function isHello(event: Pick<MessageEvent, "origin" | "source" | "data">, frame: Window | null | undefined, origin: string): boolean {
  if (!frame || !origin || event.source !== frame || event.origin !== origin) return false;
  const data = event.data as Record<string, unknown> | null;
  return !!data && typeof data === "object" && data.vokko === "hello" && data.v === PROTOCOL_VERSION;
}

/** A message from the game on its port, or null. Unknown types are dropped so the protocol can grow. */
export function parsePortMessage(raw: unknown): GameToHost | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  switch (data.type) {
    case "ready":
      return { type: "ready" };
    case "close":
      return { type: "close" };
    case "escape":
      return { type: "escape" };
    case "send":
      if (!("data" in data) || (data.to !== undefined && typeof data.to !== "string")) return null;
      return data.to === undefined ? { type: "send", data: data.data } : { type: "send", data: data.data, to: data.to as string };
    default:
      return null;
  }
}

/** Serialized size of relay data in bytes, or null when it is not JSON (undefined, a cycle, a BigInt). */
export function relayBytes(data: unknown): number | null {
  try {
    const text = JSON.stringify(data);
    return text === undefined ? null : new TextEncoder().encode(text).length;
  } catch {
    return null;
  }
}

/** Host-side check before POSTing a relay: the error to give the game, or null when it may go. */
export function checkSend(data: unknown, to: string | undefined, players: Pick<GamePlayer, "app_id">[]): GameErrorCode | null {
  const bytes = relayBytes(data);
  if (bytes === null) return "invalid";
  if (bytes > GAME_RELAY_MAX_BYTES) return "too_large";
  if (to !== undefined && !players.some(p => p.app_id === to)) return "invalid";
  return null;
}

/** The starter's app id while they are in the call, else the smallest app id present ("" for nobody). */
export function leaderOf(players: GamePlayer[], startedBy: string): string {
  const starter = players.find(p => p.user_id === startedBy);
  if (starter) return starter.app_id;
  return players.map(p => p.app_id).sort()[0] ?? "";
}

export interface FrameHostHandlers {
  /** The first message after the port is up; called when the hello is accepted. */
  init(): HostToGame;
  onMessage(message: GameToHost): void;
}

/** One port for one frame load: a second hello is ignored until a new FrameHost (a remounted frame). */
export class FrameHost {
  private port: MessagePort | null = null;
  private accepted = false;

  constructor(
    private readonly frame: HTMLIFrameElement,
    private readonly game: GameManifest,
    private readonly handlers: FrameHostHandlers,
  ) {}

  get connected(): boolean {
    return this.port !== null;
  }

  private readonly onWindowMessage = (event: MessageEvent) => {
    const target = this.frame.contentWindow;
    if (this.accepted || !target || !isHello(event, target, frameOrigin(this.game))) return;
    this.accepted = true;
    const channel = new MessageChannel();
    this.port = channel.port1;
    channel.port1.onmessage = e => {
      const message = parsePortMessage(e.data);
      if (message) this.handlers.onMessage(message);
    };
    // An opaque origin can only be addressed with "*"; the window check above already pinned the receiver.
    target.postMessage({ vokko: "init", v: PROTOCOL_VERSION }, isBuiltin(this.game) ? "*" : frameOrigin(this.game), [channel.port2]);
    this.post(this.handlers.init());
  };

  attach(): () => void {
    window.addEventListener("message", this.onWindowMessage);
    return () => this.detach();
  }

  post(message: HostToGame): void {
    this.port?.postMessage(message);
  }

  /** Tells the game it is about to unload, then drops the port. */
  detach(): void {
    window.removeEventListener("message", this.onWindowMessage);
    this.post({ type: "close" });
    this.port?.close();
    this.port = null;
  }
}
