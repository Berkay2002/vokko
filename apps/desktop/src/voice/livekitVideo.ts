// Camera, screen share and remote video for the LiveKit transport (kept apart from livekitTransport.ts, which owns the
// microphone and the room). Cameras are subscribed as soon as they are published; screen shares and their audio only
// while the user watches them (docs/design/voice.md §3.1). Our own camera is the preview's track, published as is.
// A reconnect into the same call keeps our camera and screen share and publishes them again in the new room.

import {
  Track,
  TrackEvent,
  VideoPreset,
  VideoQuality,
  type LocalTrack,
  type LocalTrackPublication,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Room,
  type TrackPublishOptions,
} from "livekit-client";
import type { Snowflake } from "../api/types";
import { hideShareBar } from "../desktop/window";
import type { VideoHandle, VideoSource } from "./mediaStore";
import type { CameraStart, TransportCallbacks } from "./transport";
import { openCamera, type CameraSession } from "./video/cameraSession";
import { buildCamera, buildScreenShare, viewerRequest, type CameraResolution, type EncodingPlan, type PlainPreset, type ScreenShareChoice, type ViewerQuality } from "./video/options";

const toPresets = (layers: PlainPreset[]): VideoPreset[] => layers.map(l => new VideoPreset({ width: l.width, height: l.height, maxBitrate: l.maxBitrate, maxFramerate: l.maxFramerate }));

/** TrackPublishOptions for a plan; `screen` selects the screen-share keys LiveKit reads for that source. */
export function publishOptions(plan: EncodingPlan, screen: boolean): TrackPublishOptions {
  const encoding = { maxBitrate: plan.encoding.maxBitrate, maxFramerate: plan.encoding.maxFramerate };
  const layers = toPresets(plan.layers);
  return {
    videoCodec: plan.codec,
    backupCodec: plan.backupCodec ? { codec: plan.backupCodec } : false,
    simulcast: plan.simulcast,
    scalabilityMode: plan.scalabilityMode,
    degradationPreference: plan.degradationPreference,
    ...(screen ? { screenShareEncoding: encoding, screenShareSimulcastLayers: layers } : { videoEncoding: encoding, videoSimulcastLayers: layers }),
  };
}

function errorName(error: unknown): string {
  return (error as { name?: string } | null)?.name ?? "";
}

const live = (track: LocalTrack | undefined): track is LocalTrack => track?.mediaStreamTrack.readyState === "live";

interface CameraCapture {
  session: CameraSession;
  resolution: CameraResolution;
}

/** A screen share's capture: the video track and, when shared, its audio. */
interface ScreenCapture {
  tracks: LocalTrack[];
  choice: ScreenShareChoice;
}

export class LiveKitVideo {
  private camera: (CameraCapture & { publication: LocalTrackPublication; room: Room }) | null = null;
  private cameraStarting = false;
  private screen: (ScreenCapture & { publication: LocalTrackPublication; room: Room }) | null = null;
  private screenStarting = false;
  /** What we published when the room went away for a reconnect: published again by resume(), stopped by reset(false). */
  private carried: { camera: CameraCapture | null; screen: ScreenCapture | null } = { camera: null, screen: null };
  private readonly watching = new Set<Snowflake>();
  private readonly qualities = new Map<string, ViewerQuality>();

  constructor(
    private readonly cb: TransportCallbacks,
    private readonly room: () => Room | null,
    private readonly joined: () => boolean,
    private readonly selfId: () => string | null,
  ) {}

  // ---- local camera ----

  async setCamera(on: boolean, start?: CameraStart): Promise<void> {
    const room = this.room();
    if (!on) {
      await this.stopCamera();
      return;
    }
    if (!room || !this.joined() || !start || this.camera || this.cameraStarting) {
      // Not able to publish: the preview keeps ownership of its session, so tell the caller nothing was started.
      if (!this.camera) this.cb.localVideoEnded?.("camera");
      return;
    }
    this.cameraStarting = true;
    let session = start.session ?? null;
    const owned = !session;
    try {
      session ??= await openCamera({ deviceId: start.deviceId, resolution: start.resolution });
      if (this.room() !== room) {
        if (owned) await session.stop();
        return;
      }
      await this.publishCamera(room, { session, resolution: start.resolution });
    } catch (error) {
      if (session) await session.stop().catch(() => undefined);
      this.cameraFailed(error);
    } finally {
      this.cameraStarting = false;
    }
  }

  private cameraFailed(error: unknown): void {
    const name = errorName(error);
    this.cb.videoFailed?.("camera", name === "NotAllowedError" || name === "SecurityError" ? "permission_denied" : name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError" ? "not_found" : "failed");
  }

  private async publishCamera(room: Room, capture: CameraCapture): Promise<void> {
    const { session } = capture;
    const plan = buildCamera(capture.resolution).publish;
    const publication = await room.localParticipant.publishTrack(session.track, { ...publishOptions(plan, false), source: Track.Source.Camera, name: "camera" });
    if (this.room() !== room) {
      // Left (or reconnected into another room) while publishing: nothing may keep the camera running.
      await room.localParticipant.unpublishTrack(session.track, false).catch(() => undefined);
      await session.stop().catch(() => undefined);
      return;
    }
    this.camera = { ...capture, publication, room };
    const ended = () => {
      if (this.camera?.session !== session) return;
      void this.stopCamera().then(() => this.cb.localVideoEnded?.("camera"));
    };
    session.track.once(TrackEvent.Ended, ended);
    const id = this.selfId();
    if (id) this.cb.video?.(id, "camera", handleOf(session));
  }

  private async stopCamera(): Promise<void> {
    const current = this.camera;
    this.camera = null;
    const carried = this.carried.camera;
    this.carried.camera = null;
    await carried?.session.stop().catch(() => undefined);
    const id = this.selfId();
    if (id) this.cb.video?.(id, "camera", null);
    if (!current) return;
    await current.room.localParticipant.unpublishTrack(current.session.track, false).catch(() => undefined);
    await current.session.stop();
  }

  // ---- local screen share ----

  async setScreenShare(on: boolean, choice?: ScreenShareChoice): Promise<void> {
    const room = this.room();
    if (!on) {
      await this.stopScreen();
      return;
    }
    if (!room || !this.joined() || !choice || this.screen || this.screenStarting) {
      if (!this.screen) this.cb.localVideoEnded?.("screen");
      return;
    }
    this.screenStarting = true;
    try {
      const request = buildScreenShare(choice);
      const publication = await room.localParticipant.setScreenShareEnabled(
        true,
        {
          audio: request.capture.audio,
          resolution: request.capture.resolution,
          contentHint: request.capture.contentHint,
          selfBrowserSurface: "exclude",
          surfaceSwitching: "include",
          systemAudio: "include",
        },
        publishOptions(request.publish, true),
      );
      if (!publication || this.room() !== room) {
        if (!publication) this.cb.localVideoEnded?.("screen");
        else await room.localParticipant.setScreenShareEnabled(false).catch(() => undefined);
        return;
      }
      const audio = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
      const tracks = [publication.track, audio].filter((track): track is LocalTrack => !!track);
      this.adoptScreen(room, publication, { tracks, choice });
      void hideShareBar();
    } catch (error) {
      const name = errorName(error);
      // Closing the browser's picker is a choice, not a failure.
      if (name === "NotAllowedError" || name === "AbortError") this.cb.localVideoEnded?.("screen");
      else this.cb.videoFailed?.("screen", name === "NotFoundError" ? "not_found" : "failed");
    } finally {
      this.screenStarting = false;
    }
  }

  private adoptScreen(room: Room, publication: LocalTrackPublication, capture: ScreenCapture): void {
    this.screen = { ...capture, publication, room };
    const [track] = capture.tracks;
    track?.once(TrackEvent.Ended, () => {
      if (this.screen?.publication !== publication) return;
      void this.stopScreen().then(() => this.cb.localVideoEnded?.("screen"));
    });
    const id = this.selfId();
    if (id && track) this.cb.video?.(id, "screen", { attach: el => void track.attach(el), detach: el => void track.detach(el) });
  }

  private async stopScreen(): Promise<void> {
    const current = this.screen;
    this.screen = null;
    for (const track of this.carried.screen?.tracks ?? []) track.stop();
    this.carried.screen = null;
    const id = this.selfId();
    if (id) this.cb.video?.(id, "screen", null);
    if (!current) return;
    await current.room.localParticipant.setScreenShareEnabled(false).catch(() => undefined);
  }

  // ---- reconnect ----

  /**
   * The next room of the same call is joined: publish again what reset(true) kept. A screen share whose capture ended
   * meanwhile stays off (a new one would need the picker); a camera LiveKit stopped with the lost room is opened again on
   * the same device with the same background, or stays off when that fails (never a plain picture of the room).
   */
  async resume(): Promise<void> {
    const { camera, screen } = this.carried;
    this.carried = { camera: null, screen: null };
    const room = this.room();
    const id = this.selfId();
    if (camera) {
      let session: CameraSession | null = camera.session;
      try {
        if (!room || !this.joined()) throw new Error("not joined");
        if (!live(session.track)) {
          await session.stop();
          session = null;
          const reopened = await openCamera({ deviceId: camera.session.deviceId, resolution: camera.resolution });
          session = reopened;
          await reopened.setBackground(camera.session.background());
        }
        if (this.room() !== room) throw new Error("left");
        await this.publishCamera(room, { session, resolution: camera.resolution });
      } catch (error) {
        await session?.stop().catch(() => undefined);
        if (id) this.cb.video?.(id, "camera", null);
        if (this.room() === room && room) this.cameraFailed(error);
        else this.cb.localVideoEnded?.("camera");
      }
    }
    if (screen) {
      const [video, audio] = screen.tracks;
      try {
        if (!room || !this.joined() || !live(video)) throw new Error("ended");
        const plan = buildScreenShare(screen.choice).publish;
        const publication = await room.localParticipant.publishTrack(video, { ...publishOptions(plan, true), source: Track.Source.ScreenShare, name: "screen" });
        if (live(audio)) await room.localParticipant.publishTrack(audio, { source: Track.Source.ScreenShareAudio, name: "screen_audio" });
        if (this.room() !== room) throw new Error("left");
        this.adoptScreen(room, publication, { tracks: live(audio) ? [video, audio] : [video], choice: screen.choice });
      } catch {
        if (this.room() === room) await room?.localParticipant.setScreenShareEnabled(false).catch(() => undefined);
        for (const track of screen.tracks) track.stop();
        if (id) this.cb.video?.(id, "screen", null);
        this.cb.localVideoEnded?.("screen");
      }
    }
  }

  // ---- remote ----

  /** Subscription policy for video and screen-share audio. Returns true when the publication was one of ours to handle. */
  consider(pub: RemoteTrackPublication, participant: RemoteParticipant, volume: number): boolean {
    if (pub.source === Track.Source.Camera) {
      pub.setSubscribed(true);
      this.applyQuality(pub, participant.identity, "camera");
      return true;
    }
    if (pub.source === Track.Source.ScreenShare) {
      pub.setSubscribed(this.watching.has(participant.identity));
      this.applyQuality(pub, participant.identity, "screen");
      return true;
    }
    if (pub.source === Track.Source.ScreenShareAudio) {
      pub.setSubscribed(this.watching.has(participant.identity));
      const track = pub.track as { setVolume?: (v: number) => void } | undefined;
      track?.setVolume?.(volume);
      return true;
    }
    return false;
  }

  attach(track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant): boolean {
    if (track.kind !== Track.Kind.Video) return false;
    const source: VideoSource = pub.source === Track.Source.ScreenShare ? "screen" : "camera";
    this.cb.video?.(participant.identity, source, { attach: el => void track.attach(el), detach: el => void track.detach(el) });
    this.applyQuality(pub, participant.identity, source);
    return true;
  }

  detach(track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant): boolean {
    if (track.kind !== Track.Kind.Video) return false;
    // The elements belong to React: detach, never remove.
    track.detach();
    this.cb.video?.(participant.identity, pub.source === Track.Source.ScreenShare ? "screen" : "camera", null);
    return true;
  }

  watch(userId: Snowflake, watch: boolean, publications: Iterable<RemoteTrackPublication>, participant: RemoteParticipant | undefined, volume: number): void {
    if (watch) this.watching.add(userId);
    else this.watching.delete(userId);
    if (!participant) return;
    for (const pub of publications) if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) this.consider(pub, participant, volume);
  }

  setQuality(userId: Snowflake, source: VideoSource, quality: ViewerQuality, pub: RemoteTrackPublication | undefined): void {
    this.qualities.set(`${userId}:${source}`, quality);
    if (pub) this.applyQuality(pub, userId, source);
  }

  private applyQuality(pub: RemoteTrackPublication, userId: Snowflake, source: VideoSource): void {
    if (pub.kind !== Track.Kind.Video || !pub.isSubscribed) return;
    const request = viewerRequest(this.qualities.get(`${userId}:${source}`) ?? "auto");
    if (request.kind === "quality") pub.setVideoQuality(VideoQuality.HIGH);
    else pub.setVideoDimensions({ width: request.width, height: request.height });
  }

  /**
   * The room is gone: forget watch / quality choices and stop what we publish, or with `carry` (a reconnect into the same
   * call) keep it for resume(). Runs its synchronous part before the caller disconnects the old room.
   */
  async reset(carry = false): Promise<void> {
    this.watching.clear();
    this.qualities.clear();
    // The room's listeners are gone before it disconnects, so no TrackUnsubscribed will clear these: every handle points at a
    // track of the old room (a reconnect would leave black tiles and a camera button that says on with nothing published).
    for (const participant of this.room()?.remoteParticipants.values() ?? []) {
      this.cb.video?.(participant.identity, "camera", null);
      this.cb.video?.(participant.identity, "screen", null);
    }
    const camera = this.camera;
    const screen = this.screen;
    this.camera = null;
    this.screen = null;
    if (carry) {
      // Out of the old room first, without stopping: Room.disconnect() stops every local track still published. A camera
      // or screen share LiveKit already stopped (the room was lost) is carried too; resume() decides what comes back.
      for (const track of [camera?.session.track, ...(screen?.tracks ?? [])]) {
        if (live(track)) void (camera?.room ?? screen?.room)?.localParticipant.unpublishTrack(track, false).catch(() => undefined);
      }
      if (camera) this.carried.camera = { session: camera.session, resolution: camera.resolution };
      if (screen) this.carried.screen = { tracks: screen.tracks, choice: screen.choice };
      return;
    }
    const carried = this.carried;
    this.carried = { camera: null, screen: null };
    const id = this.selfId();
    if (camera || carried.camera) {
      if (id) this.cb.video?.(id, "camera", null);
      this.cb.localVideoEnded?.("camera");
    }
    if (screen || carried.screen) {
      if (id) this.cb.video?.(id, "screen", null);
      this.cb.localVideoEnded?.("screen");
    }
    for (const track of carried.screen?.tracks ?? []) track.stop();
    await carried.camera?.session.stop().catch(() => undefined);
    if (camera) await camera.session.stop().catch(() => undefined);
  }
}

function handleOf(session: CameraSession): VideoHandle {
  return { attach: el => session.attach(el), detach: el => session.detach(el) };
}
