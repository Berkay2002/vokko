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
import { summariseRtpStats, voiceDebug, voiceDebugEnabled } from "./debugLog";
import { GateProcessor } from "./gate";
import type { ConnectionQuality, VoiceDevice, VoiceSettings } from "./reducer";
import type { TransportCallbacks, TransportOptions, VoiceTransport, CameraStart } from "./transport";
import { PingSmoother, selectedPairRttMs } from "./ping";
import { LiveKitVideo } from "./livekitVideo";
import type { VideoSource } from "./mediaStore";
import type { ScreenShareChoice, ViewerQuality } from "./video/options";

const PING_POLL_MS = 2000;
const STATS_POLL_MS = 5000;

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
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private lastQuality: ConnectionQuality = "unknown";
  private readonly smoother = new PingSmoother();
  private lastPing: number | null = null;
  /** A getStats call for the ping is in flight (the next poll skips instead of queueing behind it). */
  private pingSampling = false;
  private audioHost: HTMLElement | null = null;
  private readonly video: LiveKitVideo;
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
    this.video = new LiveKitVideo(cb, () => this.room, () => this.joined, () => this.room?.localParticipant.identity ?? null);
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
      audioCaptureDefaults: { echoCancellation: s.echoCancellation, noiseSuppression: this.noiseConstraint(s), autoGainControl: s.autoGainControl },
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
    for (const participant of room.remoteParticipants.values()) {
      for (const pub of participant.trackPublications.values()) this.consider(pub, participant);
      this.reportScreen(participant);
    }
    this.startPingTimer(room);
    this.statsTimer = setInterval(() => void this.logStats(room), STATS_POLL_MS);
    voiceDebug("connected", { room: room.name });
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
    const constraints = (v: VoiceSettings) => `${v.echoCancellation}${v.noiseSuppression}${v.autoGainControl}${v.rnnoise}`;
    const track = this.micPublication()?.audioTrack;
    if (track && constraints(prev) !== constraints(settings)) void this.restartMic(room, track, settings);
    if (prev.outputGain !== settings.outputGain || prev.duck !== settings.duck) this.applyVolumes();
  }

  setPttPressed(pressed: boolean): void {
    this.gate?.setKey(pressed);
  }

  setCamera(on: boolean, start?: CameraStart): Promise<void> {
    return this.video.setCamera(on, start);
  }

  setScreenShare(on: boolean, choice?: ScreenShareChoice): Promise<void> {
    return this.video.setScreenShare(on, choice);
  }

  watchStream(userId: Snowflake, watch: boolean): void {
    const participant = this.room?.remoteParticipants.get(userId);
    this.video.watch(userId, watch, participant?.trackPublications.values() ?? [], participant, this.selfDeaf ? 0 : this.volumeOf(userId));
  }

  setViewerQuality(userId: Snowflake, source: VideoSource, quality: ViewerQuality): void {
    const participant = this.room?.remoteParticipants.get(userId);
    const wanted = source === "screen" ? Track.Source.ScreenShare : Track.Source.Camera;
    const pub = participant ? [...participant.trackPublications.values()].find(p => p.source === wanted) : undefined;
    this.video.setQuality(userId, source, quality, pub);
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
        noiseSuppression: this.noiseConstraint(settings),
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

  /** Debug logging only: RTP summaries for every published and subscribed track, so a quality complaint has numbers. */
  private async logStats(room: Room): Promise<void> {
    if (this.room !== room || !voiceDebugEnabled()) return;
    const tracks: (Track | undefined)[] = [...room.localParticipant.trackPublications.values()].map(p => p.track);
    for (const participant of room.remoteParticipants.values()) for (const pub of participant.trackPublications.values()) tracks.push(pub.track);
    for (const track of tracks) {
      if (!track) continue;
      try {
        const report = await track.getRTCStatsReport();
        if (report) voiceDebug(`stats ${track.source}`, summariseRtpStats(report));
      } catch {
        // Statistics are best effort.
      }
    }
  }

  private wire(room: Room): void {
    room
      .on(RoomEvent.SignalConnected, () => this.room === room && (voiceDebug("signal connected"), this.cb.status("rtc_connecting")))
      .on(RoomEvent.Reconnecting, () => this.room === room && (voiceDebug("reconnecting"), this.cb.status("reconnecting")))
      .on(RoomEvent.SignalReconnecting, () => this.room === room && (voiceDebug("signal reconnecting"), this.cb.status("reconnecting")))
      .on(RoomEvent.Reconnected, () => this.room === room && (voiceDebug("reconnected"), this.smoother.reset(), this.cb.status("connected")))
      .on(RoomEvent.TrackPublished, (pub, participant) => {
        this.consider(pub, participant);
        this.reportScreen(participant);
      })
      .on(RoomEvent.TrackUnpublished, (_pub, participant) => this.reportScreen(participant))
      .on(RoomEvent.TrackMuted, (_pub, participant) => this.reportScreen(participant))
      .on(RoomEvent.TrackUnmuted, (_pub, participant) => this.reportScreen(participant))
      .on(RoomEvent.ParticipantConnected, participant => this.reportScreen(participant))
      .on(RoomEvent.ParticipantDisconnected, participant => this.cb.screenLive?.(participant.identity, false))
      .on(RoomEvent.TrackSubscribed, (track, pub, participant) => this.attach(track, pub, participant))
      .on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
        if (this.video.detach(track, pub, participant)) return;
        track.detach().forEach(el => el.remove());
      })
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

  /** Tells the engine whether this participant has a live (published, not muted) screen share; muted = capped by the server. */
  private reportScreen(participant: Participant): void {
    const remote = this.room?.remoteParticipants.get(participant.identity);
    if (!remote || remote !== participant) return;
    let live = false;
    for (const pub of remote.trackPublications.values()) if (pub.source === Track.Source.ScreenShare && !pub.isMuted) live = true;
    this.cb.screenLive?.(participant.identity, live);
  }

  /** Subscription policy: every microphone track, unless locally muted (volume 0 = unsubscribed, saves egress). */
  private consider(pub: RemoteTrackPublication, participant: RemoteParticipant): void {
    const volume = this.volumeOf(participant.identity);
    if (this.video.consider(pub, participant, this.selfDeaf ? 0 : volume)) return;
    if (pub.kind !== Track.Kind.Audio || pub.source !== Track.Source.Microphone) return;
    pub.setSubscribed(volume > 0);
    if (pub.track instanceof RemoteAudioTrack) pub.track.setVolume(this.selfDeaf ? 0 : volume);
  }

  private attach(track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant): void {
    if (this.video.attach(track, pub, participant)) return;
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

  /** Per-user volume x output volume x stream attenuation (0..2 before the playback clamp in LiveKit). */
  private volumeOf(userId: Snowflake): number {
    const own = this.volumes.get(userId) ?? this.options?.volumeOf(userId) ?? 1;
    const s = this.settings;
    return own * (s?.outputGain ?? 1) * (s?.duck ?? 1);
  }

  /** The browser's noise suppression covers for RNNoise when RNNoise could not start (never both at once). */
  private denoiseFallback = false;

  private noiseConstraint(s: VoiceSettings): boolean {
    return s.noiseSuppression || (s.rnnoise && this.denoiseFallback);
  }

  private useBrowserDenoise(room: Room): void {
    if (this.room !== room || this.denoiseFallback) return;
    this.denoiseFallback = true;
    const track = this.micPublication()?.audioTrack;
    if (track && this.settings) void this.restartMic(room, track, this.settings);
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
            noiseSuppression: this.noiseConstraint(settings),
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
      gate.onDenoiseUnavailable = () => this.useBrowserDenoise(room);
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

  /** One timer per room: any earlier one is cleared first, so reconnects and superseded connects never stack timers. */
  private startPingTimer(room: Room): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => void this.samplePing(room), PING_POLL_MS);
  }

  /**
   * The ping is the round trip of the selected ICE candidate pair (the media path, answered by the browser's network thread),
   * falling back to the signalling WebSocket RTT (`engine.client.rtt`, which LiveKit refreshes once per server ping interval
   * and measures with Date.now() on the main thread). Either way it is shown as a rolling average, not the raw latest value.
   */
  private async samplePing(room: Room): Promise<void> {
    if (this.room !== room || this.pingSampling) return;
    this.pingSampling = true;
    let raw: number | null = null;
    try {
      const pcm = room.engine?.pcManager;
      for (const transport of [pcm?.publisher, pcm?.subscriber]) {
        const report = await transport?.getStats();
        raw = report ? selectedPairRttMs(report) : null;
        if (raw !== null) break;
      }
    } catch {
      // Statistics are best effort; the signalling RTT below is the fallback.
    } finally {
      this.pingSampling = false;
    }
    if (this.room !== room) return;
    if (raw === null) {
      const signal = room.engine?.client?.rtt;
      raw = typeof signal === "number" && signal > 0 ? signal : null;
    }
    this.reportQuality(raw);
  }

  /** `raw` = a fresh measurement in ms (added to the rolling average); omitted = re-report the current average. */
  private reportQuality(raw?: number | null): void {
    if (raw !== undefined && raw !== null) this.lastPing = this.smoother.push(raw);
    else if (raw === null) this.lastPing = null;
    this.cb.quality(this.lastQuality, this.lastPing);
  }

  private teardownRoom(): void {
    this.joined = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.pingSampling = false;
    this.smoother.reset();
    this.lastPing = null;
    const gate = this.gate;
    this.gate = null;
    void gate?.destroy().catch(() => undefined);
    void this.video.reset();
    this.audioHost?.remove();
    this.audioHost = null;
    this.room?.removeAllListeners();
    this.room = null;
    this.lastQuality = "unknown";
    // RNNoise gets another try on the next connection (the failure may have been a one-off load error).
    this.denoiseFallback = false;
  }
}
