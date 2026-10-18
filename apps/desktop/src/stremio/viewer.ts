// The second, subscribe-only LiveKit Room of a Stremio session (docs/design/stremio-bot.md section 12): the bot publishes the
// movie to a media server of its own, and the people in the call open this Room next to their voice Room. It only attaches the
// bot's screen-share video and screen-share audio; the movie's sound plays from here under a local volume.

import { ConnectionState, RemoteAudioTrack, Room, RoomEvent, Track, type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant } from "livekit-client";
import type { VideoHandle } from "../voice/mediaStore";
import { isMockEndpoint } from "../voice/transport";
import { applyPlayoutBuffer } from "./playout";
import { receiveCue } from "./subtitles";
import { parseVideoStats, type VideoStats } from "./viewerStats";

export type ViewerStatus = "connecting" | "connected" | "closed";

export interface ViewerCallbacks {
  status(status: ViewerStatus): void;
  /** The bot's picture, or null when it is gone. */
  video(handle: VideoHandle | null): void;
  /** The browser holds back sound until the user interacts with the page. */
  audioBlocked(blocked: boolean): void;
  /** How far the picture now trails the bot's position (the playout buffer in ms), 0 when there is none; text cues are shifted by it. */
  playoutDelay(ms: number): void;
}

export interface Viewer {
  connect(url: string, token: string, botIdentity: string): Promise<void>;
  /** 0..1, applied to the movie's audio now and to any track that arrives later. */
  setVolume(volume: number): void;
  /** Resume sound after the browser blocked it (needs a user gesture). */
  startAudio(): void;
  /** Receive-side numbers of the picture (debug readout), null when there is none yet. */
  stats(): Promise<VideoStats | null>;
  disconnect(): void;
}

class LiveKitViewer implements Viewer {
  private readonly room = new Room({ adaptiveStream: true, dynacast: false, webAudioMix: true }); // User Volume above 100 % goes through Web Audio gain
  private volume = 1;
  private audio: RemoteAudioTrack | null = null;
  private videoTrack: RemoteTrack | null = null;
  private elements: HTMLMediaElement[] = [];

  constructor(private readonly cb: ViewerCallbacks, private readonly buffered: boolean) {}

  async connect(url: string, token: string, botIdentity: string): Promise<void> {
    const mine = (participant: RemoteParticipant) => participant.identity === botIdentity;
    this.room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (!mine(participant)) return;
        if (track.kind === Track.Kind.Video && pub.source === Track.Source.ScreenShare) {
          this.videoTrack = track;
          this.cb.playoutDelay(this.buffer(track.receiver));
          this.cb.video({ attach: el => void track.attach(el), detach: el => void track.detach(el) });
        } else if (track.kind === Track.Kind.Audio && pub.source === Track.Source.ScreenShareAudio && track instanceof RemoteAudioTrack) {
          this.audio = track;
          this.buffer(track.receiver);
          const el = track.attach();
          // After attach: LiveKit builds the gain node in attach and skips a stored volume of 0 (falsy), so a Mute (or 0 %) set
          // before the track arrived, or kept across a resubscribe, would play at full level.
          track.setVolume(this.volume);
          el.hidden = true;
          document.body.append(el);
          this.elements.push(el);
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (!mine(participant)) return;
        if (track.kind === Track.Kind.Video) {
          track.detach();
          if (track === this.videoTrack) this.videoTrack = null;
          this.cb.playoutDelay(0);
          this.cb.video(null);
        } else if (track === this.audio) {
          this.dropAudio();
        }
      })
      .on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
        if (participant && mine(participant)) receiveCue(botIdentity, topic, payload);
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => this.cb.audioBlocked(!this.room.canPlaybackAudio))
      .on(RoomEvent.Disconnected, () => this.cb.status("closed"));
    this.cb.status("connecting");
    await this.room.connect(url, token, { autoSubscribe: true });
    if (this.room.state === ConnectionState.Connected) this.cb.status("connected");
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.audio?.setVolume(volume);
  }

  startAudio(): void {
    void this.room.startAudio().catch(() => undefined);
  }

  async stats(): Promise<VideoStats | null> {
    const report = await this.videoTrack?.receiver?.getStats();
    return report ? parseVideoStats(report) : null;
  }

  disconnect(): void {
    this.dropAudio();
    this.cb.playoutDelay(0);
    this.cb.video(null);
    void this.room.disconnect();
  }

  /** The delay in ms now applied to the track's receiver; 0 for a Room that plays music, or where the browser cannot buffer. */
  private buffer(receiver: object | undefined): number {
    return this.buffered ? applyPlayoutBuffer(receiver) : 0;
  }

  private dropAudio(): void {
    this.audio?.detach();
    for (const el of this.elements) el.remove();
    this.elements = [];
    this.audio = null;
  }
}

/** Mock mode (url "mock://stremio"): no WebRTC. It connects after a beat and paints a stand-in picture; `volume` is for tests to read. */
export class FakeViewer implements Viewer {
  volume = 1;
  connected = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly cb: ViewerCallbacks) {}

  async connect(): Promise<void> {
    this.cb.status("connecting");
    this.timer = setTimeout(() => {
      this.connected = true;
      this.cb.status("connected");
      this.cb.video({
        attach: el => {
          el.dataset.fake = "true";
          el.style.background = "linear-gradient(135deg, #12263f, #6a2a52)";
        },
        detach: el => {
          delete el.dataset.fake;
          el.style.background = "";
        },
      });
    }, 100);
  }

  setVolume(volume: number): void {
    this.volume = volume;
  }

  startAudio(): void {}

  async stats(): Promise<VideoStats | null> {
    return null;
  }

  disconnect(): void {
    if (this.timer) clearTimeout(this.timer);
    this.connected = false;
    this.cb.video(null);
  }
}

/** `buffered`: hold the picture and sound back (a film). Music in the same Room keeps its low latency. */
export const createViewer = (url: string, cb: ViewerCallbacks, buffered = false): Viewer => (isMockEndpoint(url) ? new FakeViewer(cb) : new LiveKitViewer(cb, buffered));
