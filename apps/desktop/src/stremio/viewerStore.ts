// The viewer Room belongs to the call, not to a tile. `syncViewer` (called by ViewerHost) keeps exactly one ViewerConnection while
// we are in a call with a Stremio session and publishes its state here; a tile only reads it and attaches the picture to its
// own <video>. Focus, Back to grid and the DM call layout remount tiles without ever touching the connection.

import { create } from "zustand";
import type { Snowflake } from "../api/types";
import type { VideoHandle } from "../voice/mediaStore";
import { ViewerConnection, type MediaKind, type RoomState } from "./viewerConnection";
import type { VideoStats } from "./viewerStats";

export interface ViewerSlot {
  room: RoomState;
  video: VideoHandle | null;
  blocked: boolean;
}

export const IDLE_SLOT: ViewerSlot = { room: "connecting", video: null, blocked: false };

const VOLUME_KEY = "vokko.stremio.volume";

function readVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    const value = Number(raw);
    return raw !== null && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 60;
  } catch {
    return 60;
  }
}

interface ViewerStoreState {
  /** The channel the viewer Room is for; null while there is no Room. */
  channelId: Snowflake | null;
  slot: ViewerSlot;
  /** 0..100, local to this client and kept across sessions. */
  volume: number;
}

export const useViewerStore = create<ViewerStoreState>()(() => ({ channelId: null, slot: IDLE_SLOT, volume: readVolume() }));

/** The viewer of `channelId` as the tile sees it. */
export const useViewerSlot = (channelId: Snowflake): ViewerSlot => useViewerStore(s => (s.channelId === channelId ? s.slot : IDLE_SLOT));

export function setViewerVolume(volume: number): void {
  useViewerStore.setState({ volume });
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    /* not saved */
  }
}

let active: { key: string; connection: ViewerConnection } | null = null;
/** 0..1 as played: the volume slider, or 0 while deafened. */
let output = 1;

/** Opens the viewer Room for `target`, or closes it for null. Calling it again with the same target does nothing. */
export function syncViewer(target: { channelId: Snowflake; bot: string; kind: MediaKind } | null): void {
  const key = target ? `${target.channelId}:${target.bot}:${target.kind}` : "";
  if ((active?.key ?? "") === key) return;
  active?.connection.close();
  active = null;
  if (!target) {
    useViewerStore.setState({ channelId: null, slot: IDLE_SLOT });
    return;
  }
  const mine: { key: string; connection: ViewerConnection } = { key, connection: undefined as unknown as ViewerConnection };
  active = mine;
  const publish = (patch: Partial<ViewerSlot>) => {
    if (active === mine) useViewerStore.setState(s => ({ channelId: target.channelId, slot: { ...(s.channelId === target.channelId ? s.slot : IDLE_SLOT), ...patch } }));
  };
  mine.connection = new ViewerConnection(target.channelId, target.bot, target.kind, output, { room: room => publish({ room }), video: video => publish({ video }), blocked: blocked => publish({ blocked }) });
}

export function setViewerOutput(volume: number): void {
  output = volume;
  active?.connection.setVolume(volume);
}

export const startViewerAudio = (): void => active?.connection.startAudio();
export const readViewerStats = async (): Promise<VideoStats | null> => (await active?.connection.stats()) ?? null;
