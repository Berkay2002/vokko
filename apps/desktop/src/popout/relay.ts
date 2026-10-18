// The pure side of the main window's relay to the pop-out: which tile pops out, what the pop-out is told, what its actions turn into.
// PopoutHost.tsx wires these to the stores, the REST calls and the app events.

import type { Snowflake, StremioState, WatchTogetherState } from "../api/types";
import { shownPositionMs } from "../stremio/format";
import { expectedPositionMs } from "../watch/youtube";
import type { TextPick } from "../stremio/subtitles";
import type { PopoutAction, PopoutKind, PopoutSession } from "./protocol";

/** The tile that pops out of a call: the Stremio movie, else Watch Together. Music (Spotify) has no picture, so none. */
export function popoutKind(call: { stremio?: StremioState | undefined; watch?: WatchTogetherState | undefined }): PopoutKind | null {
  return call.stremio ? "stremio" : call.watch ? "watch" : null;
}

export interface SessionInput {
  channelId: Snowflake;
  controller: boolean;
  muted: boolean;
  stremio?: StremioState | undefined;
  watch?: WatchTogetherState | undefined;
  volume: number;
  output: number;
  pick: TextPick | null;
  skipLabel: string;
}

/** What the pop-out is told for `kind`, or null while the session it shows is gone. */
export function buildSession(kind: PopoutKind, input: SessionInput): PopoutSession | null {
  const { channelId, controller, muted } = input;
  if (kind === "stremio") return input.stremio ? { kind, channelId, controller, muted, state: input.stremio, volume: input.volume, output: input.output, pick: input.pick } : null;
  return input.watch ? { kind, channelId, controller, muted, state: input.watch, skipLabel: input.skipLabel } : null;
}

/** The position text cues wait for: the picture trails the bot's position by the playout buffer while it plays (a pause lets the frozen frame catch up). */
export function cuePositionMs(state: Pick<StremioState, "status" | "playing" | "position_ms" | "updated_at_ms" | "duration_ms">, now: number, delayMs: number): number {
  return Math.max(0, shownPositionMs(state, now) - (state.playing && state.status === "playing" ? delayMs : 0));
}

/** Where a 10 s jump lands: inside the film (a Watch Together video's length is only known to its player, so no upper bound there). */
export function jumpTarget(positionMs: number, deltaMs: number, durationMs?: number): number {
  const target = Math.max(0, positionMs + deltaMs);
  return durationMs ? Math.min(target, durationMs) : target;
}

/** The PATCH an action means for the session, or null when it is not a playback action (mute, hang up, back, ...) or the viewer may not do it. */
export function patchFor(
  action: PopoutAction,
  session: Pick<PopoutSession, "kind" | "controller" | "state">,
  now: number,
): { playing?: boolean; position_ms?: number } | null {
  if (!session.controller) return null;
  switch (action.type) {
    case "playing":
      return { playing: action.on };
    case "seek":
      return Number.isFinite(action.ms) ? { position_ms: Math.max(0, Math.round(action.ms)) } : null;
    case "jump": {
      if (!Number.isFinite(action.deltaMs)) return null;
      const position = session.kind === "stremio" ? shownPositionMs(session.state as StremioState, now) : expectedPositionMs(session.state as WatchTogetherState, now);
      const duration = session.kind === "stremio" ? (session.state as StremioState).duration_ms : undefined;
      return { position_ms: Math.round(jumpTarget(position, action.deltaMs, duration)) };
    }
    default:
      return null;
  }
}
