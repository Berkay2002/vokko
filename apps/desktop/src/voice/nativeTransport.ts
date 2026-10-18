// Voice in the Linux app: WebKitGTK has no WebRTC, so the room runs in Rust (src-tauri/src/native_voice, LiveKit's Rust SDK)
// and this transport only forwards. Same policy as livekitTransport.ts (mic published while unmuted, volume 0 unsubscribes).
// Remote cameras and screen shares play through nativeVideo.ts; publishing our own isn't there yet (no setCamera /
// setScreenShare, so the UI hides those buttons).

import { Channel, invoke } from "@tauri-apps/api/core";
import type { Snowflake } from "../api/types";
import type { VideoSource } from "./mediaStore";
import { NativeVideo } from "./nativeVideo";
import { PingSmoother } from "./ping";
import type { ConnectionQuality, VoiceDevice, VoiceSettings } from "./reducer";
import type { TransportCallbacks, TransportOptions, VoiceTransport } from "./transport";
import type { ViewerQuality } from "./video/options";

/** Events from native_voice::NativeEvent. */
type NativeEvent =
  | { type: "status"; status: "rtc_connecting" | "connected" | "reconnecting" }
  | { type: "speaking"; userIds: Snowflake[] }
  | { type: "selfSpeaking"; speaking: boolean }
  | { type: "quality"; quality: ConnectionQuality }
  | { type: "ping"; ms: number | null }
  | { type: "closed"; final: boolean; reason?: "moved" | "kicked" | null }
  | { type: "participant"; userId: Snowflake }
  | { type: "micFailed"; reason: "no_microphone" }
  | { type: "video"; userId: Snowflake; source: VideoSource; key: string | null }
  | { type: "screenLive"; userId: Snowflake; live: boolean };

const withDefault = (list: VoiceDevice[]): VoiceDevice[] => [{ deviceId: "default", label: "Default" }, ...list];

export class NativeTransport implements VoiceTransport {
  private options: TransportOptions | null = null;
  /** Bumped by every connect / disconnect: events of an older room are dropped. */
  private generation = 0;
  private readonly smoother = new PingSmoother();
  private quality: ConnectionQuality = "unknown";
  private ping: number | null = null;
  /** Remote videos we reported, by `${userId}:${source}`. */
  private readonly videos = new Map<string, NativeVideo>();

  constructor(private readonly cb: TransportCallbacks) {}

  async connect(endpoint: string, token: string, options: TransportOptions): Promise<void> {
    const generation = ++this.generation;
    this.options = options;
    this.smoother.reset();
    this.quality = "unknown";
    this.ping = null;
    const events = new Channel<NativeEvent>();
    events.onmessage = event => {
      if (generation === this.generation) this.handle(event);
    };
    const volumes: Record<Snowflake, number> = {};
    for (const id of options.participants()) volumes[id] = options.volumeOf(id);
    const init = { selfMute: options.selfMute, selfDeaf: options.selfDeaf, settings: options.settings, volumes };
    try {
      await invoke("native_voice_connect", { url: endpoint, token, init, events });
    } catch (error) {
      if (generation !== this.generation) return;
      console.warn("voice: native connect failed", error);
      this.cb.closed({ final: false });
      return;
    }
    if (generation === this.generation) void this.refreshDevices();
  }

  private handle(event: NativeEvent): void {
    switch (event.type) {
      case "status":
        if (event.status === "reconnecting") this.smoother.reset();
        return this.cb.status(event.status);
      case "speaking":
        return this.cb.speaking(event.userIds);
      case "selfSpeaking":
        return this.cb.selfSpeaking(event.speaking);
      case "quality":
        this.quality = event.quality;
        return this.cb.quality(this.quality, this.ping);
      case "ping":
        this.ping = event.ms === null ? null : this.smoother.push(event.ms);
        return this.cb.quality(this.quality, this.ping);
      case "closed":
        this.generation++;
        this.dropVideos();
        return this.cb.closed({ final: event.final, reason: event.reason ?? undefined });
      case "participant":
        if (this.options) this.setUserVolume(event.userId, this.options.volumeOf(event.userId));
        return;
      case "micFailed":
        return this.cb.micFailed?.(event.reason);
      case "video":
        return this.setVideo(event.userId, event.source, event.key);
      case "screenLive":
        return this.cb.screenLive?.(event.userId, event.live);
    }
  }

  private setVideo(userId: Snowflake, source: VideoSource, key: string | null): void {
    const id = `${userId}:${source}`;
    this.videos.get(id)?.end();
    this.videos.delete(id);
    const video = key === null ? null : new NativeVideo(key);
    if (video) this.videos.set(id, video);
    this.cb.video?.(userId, source, video);
  }

  /** The room is gone: its videos too (no event will say so). */
  private dropVideos(): void {
    for (const id of [...this.videos.keys()]) {
      const [userId, source] = id.split(":") as [Snowflake, VideoSource];
      this.setVideo(userId, source, null);
    }
  }

  async disconnect(): Promise<void> {
    this.generation++;
    this.dropVideos();
    await this.command("native_voice_disconnect");
  }

  async dispose(): Promise<void> {
    await this.disconnect();
  }

  setSelfMute(mute: boolean): void {
    void this.command("native_voice_set_mute", { mute });
  }

  setSelfDeaf(deaf: boolean): void {
    void this.command("native_voice_set_deaf", { deaf });
  }

  setUserVolume(userId: Snowflake, volume: number): void {
    void this.command("native_voice_set_user_volume", { userId, volume });
  }

  applySettings(settings: VoiceSettings): void {
    void this.command("native_voice_apply_settings", { settings });
  }

  setPttPressed(pressed: boolean): void {
    void this.command("native_voice_set_ptt", { pressed });
  }

  watchStream(userId: Snowflake, watch: boolean): void {
    void this.command("native_voice_watch", { userId, watch });
  }

  setViewerQuality(userId: Snowflake, source: VideoSource, quality: ViewerQuality): void {
    void this.command("native_voice_video_quality", { userId, source, quality });
  }

  async refreshDevices(): Promise<void> {
    try {
      const { input, output } = await invoke<{ input: VoiceDevice[]; output: VoiceDevice[] }>("native_voice_devices");
      this.cb.devices(withDefault(input), withDefault(output), true);
    } catch (error) {
      console.warn("voice: native device list failed", error);
      this.cb.devices(withDefault([]), withDefault([]), true);
    }
  }

  private async command(name: string, args?: Record<string, unknown>): Promise<void> {
    try {
      await invoke(name, args);
    } catch (error) {
      console.warn(`voice: ${name} failed`, error);
    }
  }
}
