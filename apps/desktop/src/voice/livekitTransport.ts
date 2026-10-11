// LiveKit media transport (docs/design/voice.md §3.1-3.6). Loaded lazily by the engine so mock mode and the first paint
// never pull livekit-client in. One Room per connection; the engine creates a new connect() for every new token.
// The microphone is never live by surprise: while self-muted nothing is published, and a track published during a mute race
// is muted before it goes out. Device switches keep the mute.

import {
  ConnectionQuality as LkQuality,
  DisconnectReason,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  supportsAudioOutputSelection,
  type LocalAudioTrack,
  type LocalTrackPublication,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
import type { Snowflake } from "../api/types";
import { resolveDeviceId, withDeviceFallback } from "./devices";
import { GateProcessor } from "./gate";
import type { ConnectionQuality, VoiceDevice, VoiceSettings } from "./reducer";
import type { TransportCallbacks, TransportOptions, VoiceTransport } from "./transport";

const PING_POLL_MS = 2000;

const QUALITY: Record<string, ConnectionQuality> = {
  [LkQuality.Excellent]: "excellent",
  [LkQuality.Good]: "good",
  [LkQuality.Poor]: "poor",
  [LkQuality.Lost]: "lost",
};

function toDevices(list: MediaDeviceInfo[]): VoiceDevice[] {
  const out: VoiceDevice[] = [{ deviceId: "default", label: "Default" }];
  list.forEach((d, i) => {
    if (d.deviceId && d.deviceId !== "default") out.push({ deviceId: d.deviceId, label: d.label || `Device ${i + 1}` });
  });
  return out;
}

export class LiveKitTransport implements VoiceTransport {
  private room: Room | null = null;
  private options: TransportOptions | null = null;
  private gate: GateProcessor | null = null;
  private settings: VoiceSettings | null = null;
  private selfMute = false;
  private selfDeaf = false;
  private volumes = new Map<Snowflake, number>();
  private leaving = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastQuality: ConnectionQuality = "unknown";
  private audioHost: HTMLElement | null = null;
  /** room.connect() finished for the current room (publishing before that is not possible). */
  private joined = false;
  /** Room a microphone publish is in flight for (createTracks → publishTrack). */
  private publishing: Room | null = null;
  /** Bumped by every connect / disconnect so a superseded connect stops after its next await. */
  private generation = 0;
  private readonly media: MediaDevices | undefined = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  private readonly onDeviceChange = () => void this.refreshDevices();

  constructor(private readonly cb: TransportCallbacks) {
    this.media?.addEventListener?.("devicechange", this.onDeviceChange);
  }

  async connect(endpoint: string, token: string, options: TransportOptions): Promise<void> {
    await this.disconnect();
    const generation = ++this.generation;
    this.leaving = false;
    this.options = options;
    this.settings = options.settings;
    this.selfMute = options.selfMute;
    this.selfDeaf = options.selfDeaf;
    const s = options.settings;
    const outputId = s.outputDeviceId !== "default" ? resolveDeviceId(s.outputDeviceId, await this.enumerate("audiooutput")) : "default";
    if (generation !== this.generation) return;
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      webAudioMix: true, // per-user volume above 100 % goes through Web Audio gain
      audioCaptureDefaults: { echoCancellation: s.echoCancellation, noiseSuppression: s.noiseSuppression, autoGainControl: s.autoGainControl },
      audioOutput: outputId !== "default" ? { deviceId: outputId } : undefined,
    });
    this.room = room;
    this.wire(room);
    this.audioHost = document.createElement("div");
    this.audioHost.hidden = true;
    this.audioHost.dataset.voiceAudio = "";
    document.body.append(this.audioHost);
    try {
      await room.connect(endpoint, token, { autoSubscribe: false });
    } catch (error) {
      if (this.room !== room || this.leaving) return;
      console.warn("voice: LiveKit connect failed", error);
      this.teardownRoom();
      this.cb.closed({ final: false });
      return;
    }
    if (this.room !== room) return;
    this.joined = true;
    this.cb.status("connected");
    for (const participant of room.remoteParticipants.values()) for (const pub of participant.trackPublications.values()) this.consider(pub, participant);
    this.pingTimer = setInterval(() => this.reportQuality(), PING_POLL_MS);
    void room.startAudio().catch(() => undefined);
    // Self-muted: publish nothing; the first unmute publishes the microphone.
    if (!this.selfMute) await this.publishMic();
    void this.refreshDevices();
  }

  async disconnect(): Promise<void> {
    const room = this.room;
    this.generation += 1;
    this.leaving = true;
    this.teardownRoom();
    if (room) await room.disconnect().catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.media?.removeEventListener?.("devicechange", this.onDeviceChange);
    await this.disconnect();
  }

  setSelfMute(mute: boolean): void {
    this.selfMute = mute;
    this.gate?.setMuted(mute);
    const pub = this.micPublication();
    if (!pub) {
      // publishMic re-checks the mute right before publishing, so a mute during its getUserMedia is honoured too.
      if (!mute) void this.publishMic();
      return;
    }
    void (mute ? pub.mute() : pub.unmute()).catch(() => undefined);
  }

  setSelfDeaf(deaf: boolean): void {
    this.selfDeaf = deaf;
    this.applyVolumes();
  }

  setUserVolume(userId: Snowflake, volume: number): void {
    this.volumes.set(userId, volume);
    const participant = this.room?.remoteParticipants.get(userId);
    if (!participant) return;
    for (const pub of participant.trackPublications.values()) this.consider(pub, participant);
  }

  applySettings(settings: VoiceSettings): void {
    const prev = this.settings;
    this.settings = settings;
    this.gate?.configure(settings);
    const room = this.room;
    if (!room || !prev) return;
    // Without a published microphone (muted) there is nothing to switch: the next publish reads the new settings.
    if (prev.inputDeviceId !== settings.inputDeviceId && this.micPublication()) void this.switchDevice(room, "audioinput", settings.inputDeviceId);
    if (prev.outputDeviceId !== settings.outputDeviceId && supportsAudioOutputSelection()) void this.switchDevice(room, "audiooutput", settings.outputDeviceId);
    const constraints = (v: VoiceSettings) => `${v.echoCancellation}${v.noiseSuppression}${v.autoGainControl}`;
    const track = this.micPublication()?.audioTrack;
    if (track && constraints(prev) !== constraints(settings)) void this.restartMic(room, track, settings);
  }

  setPttPressed(pressed: boolean): void {
    this.gate?.setKey(pressed);
  }

  /** Switches to a stored device (id, or a label from older prefs), falling back to the default device; keeps the mute. */
  private async switchDevice(room: Room, kind: "audioinput" | "audiooutput", pref: string): Promise<void> {
    const id = resolveDeviceId(pref, await this.enumerate(kind));
    if (this.room !== room) return;
    const attempt = async (deviceId: string) => {
      const ok = await room.switchActiveDevice(kind, deviceId);
      if (ok === false) throw Object.assign(new Error(`could not switch to ${deviceId}`), { name: "NotFoundError" });
    };
    await withDeviceFallback(id, attempt).catch(error => console.warn(`voice: ${kind} switch failed`, error));
    if (kind === "audioinput") this.enforceMute(room);
  }

  private async restartMic(room: Room, track: LocalAudioTrack, settings: VoiceSettings): Promise<void> {
    const id = resolveDeviceId(settings.inputDeviceId, await this.enumerate("audioinput"));
    const attempt = (deviceId: string) =>
      track.restartTrack({
        deviceId: deviceId !== "default" ? deviceId : undefined,
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
      });
    await withDeviceFallback(id, attempt).catch(error => console.warn("voice: microphone restart failed", error));
    this.enforceMute(room);
  }

  /** After anything that recreates or publishes the capture track: the publication follows the current self mute. */
  private enforceMute(room: Room): void {
    if (this.room !== room) return;
    this.gate?.setMuted(this.selfMute);
    const pub = this.micPublication();
    if (!pub || pub.isMuted === this.selfMute) return;
    void (this.selfMute ? pub.mute() : pub.unmute()).catch(() => undefined);
  }

  private async enumerate(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
    try {
      return await Room.getLocalDevices(kind, false);
    } catch {
      return [];
    }
  }

  async refreshDevices(): Promise<void> {
    try {
      const [input, output] = await Promise.all([Room.getLocalDevices("audioinput", false), Room.getLocalDevices("audiooutput", false)]);
      this.cb.devices(toDevices(input), toDevices(output), supportsAudioOutputSelection());
    } catch {
      this.cb.devices(toDevices([]), toDevices([]), false);
    }
  }

  private wire(room: Room): void {
    room
      .on(RoomEvent.SignalConnected, () => this.room === room && this.cb.status("rtc_connecting"))
      .on(RoomEvent.Reconnecting, () => this.room === room && this.cb.status("reconnecting"))
      .on(RoomEvent.SignalReconnecting, () => this.room === room && this.cb.status("reconnecting"))
      .on(RoomEvent.Reconnected, () => this.room === room && this.cb.status("connected"))
      .on(RoomEvent.TrackPublished, (pub, participant) => this.consider(pub, participant))
      .on(RoomEvent.TrackSubscribed, (track, pub, participant) => this.attach(track, pub, participant))
      .on(RoomEvent.TrackUnsubscribed, track => track.detach().forEach(el => el.remove()))
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        if (this.room !== room) return;
        this.cb.speaking(speakers.filter(p => p.identity !== room.localParticipant.identity).map(p => p.identity));
      })
      .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (this.room !== room || participant.identity !== room.localParticipant.identity) return;
        this.lastQuality = QUALITY[quality] ?? "unknown";
        this.reportQuality();
      })
      .on(RoomEvent.MediaDevicesChanged, () => void this.refreshDevices())
      .on(RoomEvent.Disconnected, reason => {
        if (this.room !== room || this.leaving) return;
        this.teardownRoom();
        // Duplicate identity = we joined from another device; removed = kicked / disconnected by a moderator. Never retried.
        if (reason === DisconnectReason.DUPLICATE_IDENTITY) this.cb.closed({ final: true, reason: "moved" });
        else if (reason === DisconnectReason.PARTICIPANT_REMOVED) this.cb.closed({ final: true, reason: "kicked" });
        else this.cb.closed({ final: false });
      });
  }

  /** Subscription policy: every microphone track, unless locally muted (volume 0 = unsubscribed, saves egress). */
  private consider(pub: RemoteTrackPublication, participant: RemoteParticipant): void {
    if (pub.kind !== Track.Kind.Audio || pub.source !== Track.Source.Microphone) return;
    const volume = this.volumeOf(participant.identity);
    pub.setSubscribed(volume > 0);
    if (pub.track instanceof RemoteAudioTrack) pub.track.setVolume(this.selfDeaf ? 0 : volume);
  }

  private attach(track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant): void {
    if (track.kind !== Track.Kind.Audio || !this.audioHost) return;
    const el = track.attach();
    el.dataset.userId = participant.identity; // e2e (real.voice.spec.ts) reads subscriptions from these elements
    this.audioHost.append(el);
    this.consider(pub, participant);
  }

  private applyVolumes(): void {
    const room = this.room;
    if (!room) return;
    for (const participant of room.remoteParticipants.values()) for (const pub of participant.trackPublications.values()) this.consider(pub, participant);
  }

  private volumeOf(userId: Snowflake): number {
    return this.volumes.get(userId) ?? this.options?.volumeOf(userId) ?? 1;
  }

  private micPublication(): LocalTrackPublication | undefined {
    return this.room?.localParticipant.getTrackPublication(Track.Source.Microphone);
  }

  /**
   * Captures and publishes the microphone (connected and not muted only). The track is muted before publishTrack whenever
   * we are muted at that moment, so a publish never announces an open microphone while self-muted.
   */
  private async publishMic(): Promise<void> {
    const room = this.room;
    const settings = this.settings;
    if (!room || !settings || !this.joined || this.selfMute || this.publishing === room || this.micPublication()) return;
    this.publishing = room;
    let track: LocalAudioTrack | null = null;
    try {
      const wanted = resolveDeviceId(settings.inputDeviceId, await this.enumerate("audioinput"));
      const capture = async (deviceId: string) => {
        const [created] = await room.localParticipant.createTracks({
          audio: {
            deviceId: deviceId !== "default" ? deviceId : undefined,
            echoCancellation: settings.echoCancellation,
            noiseSuppression: settings.noiseSuppression,
            autoGainControl: settings.autoGainControl,
          },
        });
        if (!created) throw Object.assign(new Error("no audio track"), { name: "NotFoundError" });
        return created as LocalAudioTrack;
      };
      track = (await withDeviceFallback(wanted, capture)).result;
      if (this.room !== room) return;
      if (this.selfMute) await track.mute();
      this.gate?.destroy().catch(() => undefined);
      const gate = new GateProcessor(this.settings ?? settings, this.selfMute, open => this.cb.selfSpeaking(open));
      try {
        await track.setProcessor(gate);
        this.gate = gate;
      } catch (error) {
        // No Web Audio context: publish the plain microphone (no VAD / PTT gating, the mute still applies).
        console.warn("voice: gate unavailable", error);
        this.gate = null;
      }
      if (this.room !== room) return;
      if (this.selfMute && !track.isMuted) await track.mute();
      await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone });
      track = null; // owned by the room now
      this.enforceMute(room);
    } catch (error) {
      if (this.room !== room) return;
      const name = (error as { name?: string } | null)?.name;
      this.cb.micFailed?.(name === "NotAllowedError" || name === "SecurityError" ? "permission_denied" : "no_microphone");
    } finally {
      if (this.publishing === room) this.publishing = null;
      track?.stop();
    }
  }

  private reportQuality(): void {
    const rtt = this.room?.engine?.client?.rtt;
    this.cb.quality(this.lastQuality, typeof rtt === "number" && rtt > 0 ? Math.round(rtt) : null);
  }

  private teardownRoom(): void {
    this.joined = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const gate = this.gate;
    this.gate = null;
    void gate?.destroy().catch(() => undefined);
    this.audioHost?.remove();
    this.audioHost = null;
    this.room?.removeAllListeners();
    this.room = null;
    this.lastQuality = "unknown";
  }
}
