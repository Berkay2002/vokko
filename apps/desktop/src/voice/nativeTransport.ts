// Voice in the Linux app: WebKitGTK has no WebRTC, so the room runs in Rust (src-tauri/src/native_voice, LiveKit's Rust SDK)
// and this transport only forwards. Same policy as livekitTransport.ts (mic published while unmuted, volume 0 unsubscribes).
// Remote cameras and screen shares play through nativeVideo.ts. Our own are captured in Rust too (V4L2 cameras, the
// screen through the xdg-desktop-portal on Wayland or the whole X11 screen), so the page's camera preview is closed before
// Rust opens the device. VP8 simulcast with the layers options.ts plans; no screen-share audio; a reconnect drops them.

import { Channel, invoke } from "@tauri-apps/api/core";
import type { Snowflake } from "../api/types";
import type { VideoSource } from "./mediaStore";
import { NativeVideo } from "./nativeVideo";
import { PingSmoother } from "./ping";
import type { ConnectionQuality, VoiceDevice, VoiceSettings } from "./reducer";
import type { CameraStart, TransportCallbacks, TransportOptions, VoiceTransport } from "./transport";
import { buildCamera, buildScreenShare, type PlainPreset, type ScreenShareChoice, type ViewerQuality } from "./video/options";

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
  | { type: "screenLive"; userId: Snowflake; live: boolean }
  | { type: "localEnded"; source: VideoSource };

/** native_voice::outgoing::VideoPlan. */
interface VideoPlan {
  width: number;
  height: number;
  fps: number;
  maxBitrate: number;
  layers: PlainPreset[];
  deviceId?: string;
}

// Rust encodes VP8 only, and VP8 simulcast works everywhere.
const VP8 = { vp8: true, svcSimulcast: false };

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
    // Rust closes the old room's tracks without an event: our own camera / screen share tiles go with them.
    this.dropVideos();
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
        // Our capture stops with the page's tile (Rust also stops it when the room goes), not at the retry's end.
        void this.command("native_voice_set_video", { source: "camera", plan: null });
        void this.command("native_voice_set_video", { source: "screen", plan: null });
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
      case "localEnded":
        void this.stopLocal(event.source).then(() => this.cb.localVideoEnded?.(event.source));
        return;
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

  async setCamera(on: boolean, start?: CameraStart): Promise<void> {
    // A preview capture holds the camera: Rust opens the device itself.
    await start?.session?.stop().catch(() => undefined);
    if (!on || !start) return on ? this.cb.localVideoEnded?.("camera") : this.stopLocal("camera");
    const { capture, publish } = buildCamera(start.resolution, VP8);
    // Device ids from the page's enumerateDevices are WebKit's, not V4L2 paths: Rust then takes the first camera.
    const deviceId = start.deviceId?.startsWith("/dev/") ? start.deviceId : undefined;
    const plan = { width: capture.width, height: capture.height, fps: capture.frameRate, maxBitrate: publish.encoding.maxBitrate, layers: publish.layers, deviceId };
    await this.startLocal("camera", plan);
  }

  async setScreenShare(on: boolean, choice?: ScreenShareChoice): Promise<void> {
    if (!on || !choice) return on ? this.cb.localVideoEnded?.("screen") : this.stopLocal("screen");
    const { capture, publish } = buildScreenShare(choice, VP8);
    const { width, height, frameRate } = capture.resolution;
    if (await this.startLocal("screen", { width, height, fps: frameRate, maxBitrate: publish.encoding.maxBitrate, layers: publish.layers })) {
      if (choice.audio) this.cb.screenAudioMissing?.();
    }
  }

  /** Publishes our camera / screen share; true once it is live. The portal picker closed is not a failure. */
  private async startLocal(source: VideoSource, plan: VideoPlan): Promise<boolean> {
    const generation = this.generation;
    try {
      const key = await invoke<string | null>("native_voice_set_video", { source, plan });
      const self = this.options?.selfId;
      if (generation !== this.generation || !key || !self) return false;
      this.setVideo(self, source, key);
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      if (error === "cancelled") this.cb.localVideoEnded?.(source);
      else this.cb.videoFailed?.(source, error === "permission_denied" || error === "not_found" ? error : "failed");
      return false;
    }
  }

  private async stopLocal(source: VideoSource): Promise<void> {
    const self = this.options?.selfId;
    if (self && this.videos.has(`${self}:${source}`)) this.setVideo(self, source, null);
    await this.command("native_voice_set_video", { source, plan: null });
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
