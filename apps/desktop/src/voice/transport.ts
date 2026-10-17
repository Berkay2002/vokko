// Media transport behind the voice engine: LiveKit in real mode, a fake one in mock mode (endpoint "mock://…").

import type { Snowflake } from "../api/types";
import type { VideoHandle, VideoSource } from "./mediaStore";
import type { ConnectionQuality, VoiceDevice, VoiceErrorReason, VoiceSettings } from "./reducer";
import type { CameraSession } from "./video/cameraSession";
import type { CameraResolution, ScreenShareChoice, ViewerQuality } from "./video/options";

export interface TransportCallbacks {
  /** Media connection progress. "rtc_connecting" = signalling done, ICE/DTLS in progress. */
  status(status: "rtc_connecting" | "connected" | "reconnecting"): void;
  /** Remote participants (user ids) currently speaking. */
  speaking(userIds: Snowflake[]): void;
  /** Local gate opened/closed (self speaking ring). */
  selfSpeaking(speaking: boolean): void;
  quality(quality: ConnectionQuality, pingMs: number | null): void;
  /** The connection is gone. `final` = never retry (moved to another device, kicked); otherwise the engine re-sends op 4. */
  closed(info: { final: boolean; reason?: VoiceErrorReason }): void;
  devices(input: VoiceDevice[], output: VoiceDevice[], outputSelectable: boolean): void;
  /** The microphone could not be opened; the call continues listen-only. */
  micFailed?(reason: Extract<VoiceErrorReason, "permission_denied" | "no_microphone">): void;
  /** A video became available (or went away with null) for a user's camera / screen share; ours are reported too. */
  video?(userId: Snowflake, source: VideoSource, handle: VideoHandle | null): void;
  /** A remote user's screen share became published (live, not muted) or went away; reported by the LiveKit transport only. */
  screenLive?(userId: Snowflake, live: boolean): void;
  /** Our camera or screen share ended without us asking (the browser's "Stop sharing" bar, camera unplugged). */
  localVideoEnded?(source: VideoSource): void;
  /** A camera / screen share start failed (permission denied, no camera). Cancelling the picker is not an error. */
  videoFailed?(source: VideoSource, reason: "permission_denied" | "not_found" | "failed"): void;
}

export interface TransportOptions {
  selfMute: boolean;
  selfDeaf: boolean;
  settings: VoiceSettings;
  /** Playback volume per user id (0..2, 0 also unsubscribes). */
  volumeOf(userId: Snowflake): number;
  /** Other users in the channel per the voice states (the fake transport makes them talk). */
  participants(): Snowflake[];
  /** Our own user id (the id local videos are reported under). */
  selfId?: Snowflake | null;
  /** Which of a user's videos are live per the voice states (self_video / self_stream); the fake transport mirrors them. */
  videoOf?(userId: Snowflake): { camera: boolean; screen: boolean };
  /** Quality a viewer asked for on a stream (settings default when never changed). */
  viewerQuality?(userId: Snowflake, source: VideoSource): ViewerQuality;
  /** A reconnect into the same call: publish again the camera / screen share the previous connection had (never new ones). */
  resume?: boolean;
}

export interface CameraStart {
  resolution: CameraResolution;
  /** An open preview capture (already processed) to publish as is; without it the transport opens the camera. */
  session?: CameraSession | null;
  deviceId?: string;
}

export interface VoiceTransport {
  connect(endpoint: string, token: string, options: TransportOptions): Promise<void>;
  /** Client-initiated: no `closed` callback follows. */
  disconnect(): Promise<void>;
  /** Disconnects and releases everything the transport holds (device listeners); the instance is not used again. */
  dispose(): Promise<void>;
  setSelfMute(mute: boolean): void;
  setSelfDeaf(deaf: boolean): void;
  /** 0..2; 0 = local mute (also unsubscribes). */
  setUserVolume(userId: Snowflake, volume: number): void;
  applySettings(settings: VoiceSettings): void;
  /** Push-to-talk key state (ignored in voice-activity mode). */
  setPttPressed(pressed: boolean): void;
  refreshDevices(): Promise<void>;
  // ---- video (optional: a transport without these simply has no camera / screen share) ----
  setCamera?(on: boolean, start?: CameraStart): Promise<void>;
  setScreenShare?(on: boolean, choice?: ScreenShareChoice): Promise<void>;
  /** Subscribe to (or drop) a user's screen share and its audio. Cameras are always subscribed. */
  watchStream?(userId: Snowflake, watch: boolean): void;
  setViewerQuality?(userId: Snowflake, source: VideoSource, quality: ViewerQuality): void;
  /** Recompute which remote videos should exist (the voice states changed). */
  syncVideo?(): void;
}

/** Participants of the media rooms are not users, so nothing maps them to one: the Stremio bot is `bot:stremio:<channel_id>`, the other viewers are `viewer:<user_id>:<hex>`. */
export const isMediaIdentity = (identity: string): boolean => identity.startsWith("bot:") || identity.startsWith("viewer:");

export const isMockEndpoint = (endpoint: string): boolean => endpoint.startsWith("mock://");
