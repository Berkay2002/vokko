// Camera, screen share and remote video for the LiveKit transport (kept apart from livekitTransport.ts, which owns the
// microphone and the room). Cameras are subscribed as soon as they are published; screen shares and their audio only
// while the user watches them (docs/design/voice.md §3.1). Our own camera is the preview's track, published as is.

import { Track, TrackEvent, VideoPreset, VideoQuality, type LocalTrackPublication, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication, type Room, type TrackPublishOptions } from "livekit-client";
import type { Snowflake } from "../api/types";
import { hideShareBar } from "../desktop/window";
import type { VideoHandle, VideoSource } from "./mediaStore";
import type { CameraStart, TransportCallbacks } from "./transport";
import { openCamera, type CameraSession } from "./video/cameraSession";
import { buildCamera, buildScreenShare, viewerRequest, type EncodingPlan, type PlainPreset, type ScreenShareChoice, type ViewerQuality } from "./video/options";

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

export class LiveKitVideo {
  private camera: { session: CameraSession; publication: LocalTrackPublication; room: Room } | null = null;
  private cameraStarting = false;
  private screen: { publication: LocalTrackPublication; room: Room } | null = null;
  private screenStarting = false;
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
      const plan = buildCamera(start.resolution).publish;
      const publication = await room.localParticipant.publishTrack(session.track, { ...publishOptions(plan, false), source: Track.Source.Camera, name: "camera" });
      if (this.room() !== room) {
        // Left (or reconnected into another room) while publishing: nothing may keep the camera running.
        await room.localParticipant.unpublishTrack(session.track, false).catch(() => undefined);
        await session.stop().catch(() => undefined);
        return;
      }
      this.camera = { session, publication, room };
      const ended = () => {
        if (this.camera?.session !== session) return;
        void this.stopCamera().then(() => this.cb.localVideoEnded?.("camera"));
      };
      session.track.once(TrackEvent.Ended, ended);
      const id = this.selfId();
      if (id) this.cb.video?.(id, "camera", handleOf(session));
    } catch (error) {
      if (session) await session.stop().catch(() => undefined);
      const name = errorName(error);
      this.cb.videoFailed?.("camera", name === "NotAllowedError" || name === "SecurityError" ? "permission_denied" : name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError" ? "not_found" : "failed");
    } finally {
      this.cameraStarting = false;
    }
  }

  private async stopCamera(): Promise<void> {
    const current = this.camera;
    this.camera = null;
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
      this.screen = { publication, room };
      void hideShareBar();
      publication.track?.once(TrackEvent.Ended, () => {
        if (this.screen?.publication !== publication) return;
        void this.stopScreen().then(() => this.cb.localVideoEnded?.("screen"));
      });
      const id = this.selfId();
      const track = publication.track;
      if (id && track) this.cb.video?.(id, "screen", { attach: el => void track.attach(el), detach: el => void track.detach(el) });
    } catch (error) {
      const name = errorName(error);
      // Closing the browser's picker is a choice, not a failure.
      if (name === "NotAllowedError" || name === "AbortError") this.cb.localVideoEnded?.("screen");
      else this.cb.videoFailed?.("screen", name === "NotFoundError" ? "not_found" : "failed");
    } finally {
      this.screenStarting = false;
    }
  }

  private async stopScreen(): Promise<void> {
    const current = this.screen;
    this.screen = null;
    const id = this.selfId();
    if (id) this.cb.video?.(id, "screen", null);
    if (!current) return;
    await current.room.localParticipant.setScreenShareEnabled(false).catch(() => undefined);
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

  /** The room is gone: stop what we publish and forget watch / quality choices. */
  async reset(): Promise<void> {
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
    const id = this.selfId();
    if (camera) {
      if (id) this.cb.video?.(id, "camera", null);
      this.cb.localVideoEnded?.("camera");
    }
    if (screen) {
      if (id) this.cb.video?.(id, "screen", null);
      this.cb.localVideoEnded?.("screen");
    }
    if (camera) await camera.session.stop().catch(() => undefined);
  }
}

function handleOf(session: CameraSession): VideoHandle {
  return { attach: el => session.attach(el), detach: el => session.detach(el) };
}
