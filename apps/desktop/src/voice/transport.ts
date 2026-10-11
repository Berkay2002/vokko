// Media transport behind the voice engine: LiveKit in real mode, a fake one in mock mode (endpoint "mock://…").

import type { Snowflake } from "../api/types";
import type { ConnectionQuality, VoiceDevice, VoiceErrorReason, VoiceSettings } from "./reducer";

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
}

export interface TransportOptions {
  selfMute: boolean;
  selfDeaf: boolean;
  settings: VoiceSettings;
  /** Playback volume per user id (0..2, 0 also unsubscribes). */
  volumeOf(userId: Snowflake): number;
  /** Other users in the channel per the voice states (the fake transport makes them talk). */
  participants(): Snowflake[];
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
}

export const isMockEndpoint = (endpoint: string): boolean => endpoint.startsWith("mock://");
