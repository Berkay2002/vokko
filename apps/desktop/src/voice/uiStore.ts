// Client-side state the voice UI needs and the wire contract has no field for: whether the text-in-voice panel is open,
// the instance bitrate ceiling from READY, the recent pings, the call stage focus (focused tile, hidden member strip) and a
// ticking clock for elapsed timers.
// (The channel status text is server state now: `useVoice(s => s.channelStatus[id])`, set with `setVoiceChannelStatus`.)

import { useEffect, useState } from "react";
import { create } from "zustand";
import { gateway } from "../api/gateway";
import type { Snowflake } from "../api/types";
import { voiceStore } from "./store";

const KEY = "vokko.voiceUi";
const DEFAULT_CEILING = 128_000;

interface Persisted {
  chatOpen: boolean;
}

function load(): Persisted {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Persisted>;
    return { chatOpen: parsed.chatOpen === true };
  } catch {
    return { chatOpen: false };
  }
}

export interface PingSample {
  at: number;
  ms: number;
}

const PING_HISTORY_MAX = 120;

interface VoiceUiStore extends Persisted {
  /** READY `media.voice_bitrate_ceiling` in bps. */
  bitrateCeiling: number;
  /** Ping measurements of the current call, newest last (connection details chart). */
  pingHistory: PingSample[];
  /** User whose tile fills the call stage (focus mode); null = grid. Reset when the call ends or changes channel. */
  focusedTile: Snowflake | null;
  /** Focus mode: the strip of the other tiles is hidden. */
  membersHidden: boolean;
  /**
   * A stream the stage should focus, set by "Watch Stream" outside the stage (the channel list's stream preview card).
   * The stage reads it, focuses that user's screen share and calls `requestStreamFocus(null)` once it has.
   */
  focusStream: Snowflake | null;
  setChatOpen(open: boolean): void;
  requestStreamFocus(userId: Snowflake | null): void;
  setFocusedTile(userId: Snowflake | null): void;
  setMembersHidden(hidden: boolean): void;
}

function persist(state: Persisted): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ chatOpen: state.chatOpen }));
  } catch {
    /* storage unavailable: the choice still applies for this session */
  }
}

export const useVoiceUi = create<VoiceUiStore>()(set => ({
  ...load(),
  bitrateCeiling: DEFAULT_CEILING,
  pingHistory: [],
  focusedTile: null,
  membersHidden: false,
  focusStream: null,
  setChatOpen(open) {
    set({ chatOpen: open });
    persist({ chatOpen: open });
  },
  requestStreamFocus(userId) {
    set({ focusStream: userId });
  },
  setFocusedTile(userId) {
    set({ focusedTile: userId });
  },
  setMembersHidden(hidden) {
    set({ membersHidden: hidden });
  },
}));

if (typeof window !== "undefined") {
  gateway.on("READY", ready => {
    const ceiling = ready.media?.voice_bitrate_ceiling;
    useVoiceUi.setState({ bitrateCeiling: typeof ceiling === "number" && ceiling >= 8000 ? ceiling : DEFAULT_CEILING });
  });
  // The voice store only keeps the latest ping; the connection details popout charts the recent ones.
  voiceStore.subscribe((state, prev) => {
    if (state.channelId !== prev.channelId) useVoiceUi.setState({ pingHistory: [], focusedTile: null, membersHidden: false, ...(state.channelId === null ? { focusStream: null } : {}) });
    if (state.channelId && state.pingMs !== null && state.pingMs !== prev.pingMs) {
      const history = [...useVoiceUi.getState().pingHistory, { at: Date.now(), ms: state.pingMs }];
      useVoiceUi.setState({ pingHistory: history.slice(-PING_HISTORY_MAX) });
    }
  });
}

/** Seconds since `since` (ISO string), re-rendering once a second. 0 when there is no start time. */
export function useElapsedSeconds(since: string | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  const start = since ? Date.parse(since) : NaN;
  return Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
}

/** "5:28", "1:02:03". */
export function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
