// Video side of a call: our camera / screen share, the remote videos the transport attached, which streams we watch and
// the quality we asked for. The audio model (reducer.ts) stays untouched; this store is only about pictures.

import { create } from "zustand";
import type { Snowflake, VoiceState } from "../api/types";
import { useVoice } from "./store";
import type { StreamLayer, ViewerQuality } from "./video/options";

export type VideoSource = "camera" | "screen";

/** A video the UI can show in a <video> element, whoever it comes from (a LiveKit track, a fake canvas stream). */
export interface VideoHandle {
  attach(element: HTMLVideoElement): void;
  detach(element: HTMLVideoElement): void;
  /** The layers a remote stream is published with, when known (the stream quality menu offers these). */
  layers?: readonly StreamLayer[];
}

export const videoKey = (userId: Snowflake, source: VideoSource): string => `${userId}:${source}`;

export interface MediaState {
  /** Attached videos by `${userId}:${source}`; local ones are under our own id. */
  videos: Record<string, VideoHandle>;
  /** Screen shares we chose to watch (they cost nothing until then, design §3.1). */
  watching: Record<Snowflake, true>;
  /** Per-stream choice from the stream quality menu; missing = the default from settings. */
  quality: Record<string, ViewerQuality>;
  /** Users whose screen share the media transport sees published (live, not muted) in the call we are in. The voice
   *  state's self_stream normally carries this (LiveKit webhook); this is the same fact straight from the SFU. */
  liveScreens: Record<Snowflake, true>;
  /** Our camera / screen share are being published. */
  cameraOn: boolean;
  screenOn: boolean;
  /** Last start failure the UI should show once (permission denied, no camera, picker cancelled is not one). */
  error: string | null;
}

export const useMedia = create<MediaState>()(() => ({ videos: {}, watching: {}, quality: {}, liveScreens: {}, cameraOn: false, screenOn: false, error: null }));
export const getMedia = (): MediaState => useMedia.getState();

export function setVideo(userId: Snowflake, source: VideoSource, handle: VideoHandle | null): void {
  const key = videoKey(userId, source);
  useMedia.setState(state => {
    if (!handle) {
      if (!(key in state.videos)) return state;
      const videos = { ...state.videos };
      delete videos[key];
      return { videos };
    }
    return { videos: { ...state.videos, [key]: handle } };
  });
}

export function setWatching(userId: Snowflake, watching: boolean): void {
  useMedia.setState(state => {
    if (watching === !!state.watching[userId]) return state;
    const next = { ...state.watching };
    if (watching) next[userId] = true;
    else delete next[userId];
    return { watching: next };
  });
}

export function setLiveScreen(userId: Snowflake, live: boolean): void {
  useMedia.setState(state => {
    if (live === !!state.liveScreens[userId]) return state;
    const next = { ...state.liveScreens };
    if (live) next[userId] = true;
    else delete next[userId];
    return { liveScreens: next };
  });
}

export function setStreamQuality(userId: Snowflake, source: VideoSource, quality: ViewerQuality): void {
  useMedia.setState(state => ({ quality: { ...state.quality, [videoKey(userId, source)]: quality } }));
}

export function setLocalState(patch: Partial<Pick<MediaState, "cameraOn" | "screenOn" | "error">>): void {
  useMedia.setState(patch);
}

/** Leaving the call: nothing of it may linger (handles point at tracks that are gone). */
export function resetMedia(): void {
  useMedia.setState({ videos: {}, watching: {}, quality: {}, liveScreens: {}, cameraOn: false, screenOn: false, error: null });
}

export const useVideo = (userId: Snowflake, source: VideoSource): VideoHandle | undefined => useMedia(s => s.videos[videoKey(userId, source)]);

/**
 * Whether a voice state is streaming. The webhook-fed `self_stream` stays the authority and is enough on its own; a
 * screen share the media transport sees published in the call we are in counts too (the SFU only lets people with the
 * STREAM grant publish one), so a missing or late webhook does not hide a stream. Ours counts while it is being published.
 */
export function isStreaming(state: VoiceState, liveScreens: MediaState["liveScreens"], meId: Snowflake | null, channelId: Snowflake | null, screenOn: boolean): boolean {
  if (state.self_stream) return true;
  if (state.channel_id === null || state.channel_id !== channelId) return false;
  return state.user_id === meId ? screenOn : !!liveScreens[state.user_id];
}

/** `isStreaming` bound to the current stores, for lists of states. */
export function useStreamingCheck(): (state: VoiceState) => boolean {
  const liveScreens = useMedia(s => s.liveScreens);
  const screenOn = useMedia(s => s.screenOn);
  const meId = useVoice(s => s.meId);
  const channelId = useVoice(s => s.channelId);
  return state => isStreaming(state, liveScreens, meId, channelId, screenOn);
}

export const useIsStreaming = (state: VoiceState): boolean => useStreamingCheck()(state);
