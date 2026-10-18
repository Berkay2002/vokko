// What the main window and the pop-out window say to each other over app events (src-tauri/src/popout.rs only creates, moves and
// closes the window; it never sees these payloads). The pop-out has no gateway, stores or login: it draws what main sends and sends
// its button presses back. Same shape as the in-game overlay (src/overlay/protocol.ts).

import type { Snowflake, StremioCue, StremioState, WatchTogetherPatchRequest, WatchTogetherState } from "../api/types";
import type { TextPick } from "../stremio/subtitles";

/** Main → pop-out: the whole picture, sent on every change and when the pop-out asks (`popout-ready`). */
export const SESSION_EVENT = "popout-session";
/** Pop-out → main: the page loaded and wants the session. */
export const READY_EVENT = "popout-ready";
/** Pop-out → main: a button or key was used. */
export const ACTION_EVENT = "popout-action";
/** Main → pop-out: the answer to a `token` action (a fresh viewer-room token, or the reason there is none). */
export const TOKEN_EVENT = "popout-token";
/** Main → pop-out: the cues of an addon subtitle (a REST call only main can make). Embedded cues come from the pop-out's own Room. */
export const CUES_EVENT = "popout-cues";
/** Rust → main: the pop-out window is gone (its Close, Back to call, the call ending, quitting). */
export const CLOSED_EVENT = "popout-closed";

export type PopoutKind = "stremio" | "watch";

interface Common {
  channelId: Snowflake;
  /** May play, pause and seek (useCanControlMedia); everyone else sees progress only, and skip becomes a vote. */
  controller: boolean;
  /** Microphone muted or deafened, as the call bar shows it. */
  muted: boolean;
}

export interface StremioSession extends Common {
  kind: "stremio";
  state: StremioState;
  /** The tile's volume slider, 0..100. */
  volume: number;
  /** What the pop-out plays: slider times User Volume, 0 while deafened (0..2). Main plays nothing while popped out. */
  output: number;
  /** The viewer's own subtitle choice for this film (the tile's Languages menu); null for none. The pop-out works out the line itself. */
  pick: TextPick | null;
}

export interface WatchSession extends Common {
  kind: "watch";
  state: WatchTogetherState;
  /** "Skip" or "Vote to skip (1/3)": the skip button's name. */
  skipLabel: string;
}

export type PopoutSession = StremioSession | WatchSession;

/** A Watch Together PATCH the hosted player wants (ended: skip; first to know the title: title). Nothing else is forwarded. */
export type WatchPatch = Pick<WatchTogetherPatchRequest, "skip" | "video_id" | "title">;

export type PopoutAction =
  | { type: "playing"; on: boolean }
  /** Relative: main knows the position from the server's state. */
  | { type: "jump"; deltaMs: number }
  | { type: "seek"; ms: number }
  | { type: "skip" }
  /** The Stremio tile volume, 0..100. */
  | { type: "volume"; value: number }
  | { type: "mute" }
  | { type: "hangup" }
  | { type: "back" }
  /** `id` pairs the reply (TokenReply) with the ask. */
  | { type: "token"; id: number }
  | { type: "watch-patch"; patch: WatchPatch };

export type TokenReply = { id: number } & ({ url: string; token: string } | { error: string });

/** The cues of the addon subtitle `sid`. */
export interface CuesReply {
  sid: string;
  cues: StremioCue[];
}

/** The only Watch Together PATCH keys main forwards for the pop-out. */
export function watchPatch(patch: unknown): WatchPatch | null {
  if (!patch || typeof patch !== "object") return null;
  const { skip, video_id: videoId, title, ...rest } = patch as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  const out: WatchPatch = {};
  if (skip !== undefined) {
    if (typeof skip !== "boolean") return null;
    out.skip = skip;
  }
  if (videoId !== undefined) {
    if (typeof videoId !== "string") return null;
    out.video_id = videoId;
  }
  if (title !== undefined) {
    if (typeof title !== "string") return null;
    out.title = title.slice(0, 500);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The step of the arrow keys and the jump buttons. */
export const JUMP_MS = 10_000;
