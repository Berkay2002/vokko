// The second, subscribe-only LiveKit Room of a Stremio session (docs/design/stremio-bot.md section 12): the bot publishes the
// movie to a media server of its own, and the people in the call open this Room next to their voice Room. It only attaches the
// bot's screen-share video and screen-share audio; the movie's sound plays from here under a local volume.

import { ConnectionState, RemoteAudioTrack, Room, RoomEvent, Track, type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant } from "livekit-client";
import type { VideoHandle } from "../voice/mediaStore";
import { isMockEndpoint } from "../voice/transport";

export type ViewerStatus = "connecting" | "connected" | "closed";

export interface ViewerCallbacks {
  status(status: ViewerStatus): void;
  /** The bot's picture, or null when it is gone. */
  video(handle: VideoHandle | null): void;
  /** The browser holds back sound until the user interacts with the page. */
  audioBlocked(blocked: boolean): void;
}

export interface Viewer {
  connect(url: string, token: string, botIdentity: string): Promise<void>;
  /** 0..1, applied to the movie's audio now and to any track that arrives later. */
  setVolume(volume: number): void;
  /** Resume sound after the browser blocked it (needs a user gesture). */
  startAudio(): void;
  disconnect(): void;
}

class LiveKitViewer implements Viewer {
  private readonly room = new Room({ adaptiveStream: true, dynacast: false });
  private volume = 1;
  private audio: RemoteAudioTrack | null = null;
  private elements: HTMLMediaElement[] = [];

  constructor(private readonly cb: ViewerCallbacks) {}

  async connect(url: string, token: string, botIdentity: string): Promise<void> {
    const mine = (participant: RemoteParticipant) => participant.identity === botIdentity;
    this.room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (!mine(participant)) return;
        if (track.kind === Track.Kind.Video && pub.source === Track.Source.ScreenShare) {
          this.cb.video({ attach: el => void track.attach(el), detach: el => void track.detach(el) });
        } else if (track.kind === Track.Kind.Audio && pub.source === Track.Source.ScreenShareAudio && track instanceof RemoteAudioTrack) {
          this.audio = track;
          track.setVolume(this.volume);
          const el = track.attach();
          el.hidden = true;
          document.body.append(el);
          this.elements.push(el);
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (!mine(participant)) return;
        if (track.kind === Track.Kind.Video) {
          track.detach();
          this.cb.video(null);
        } else if (track === this.audio) {
          this.dropAudio();
        }
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

  disconnect(): void {
    this.dropAudio();
    this.cb.video(null);
    void this.room.disconnect();
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

  disconnect(): void {
    if (this.timer) clearTimeout(this.timer);
    this.connected = false;
    this.cb.video(null);
  }
}

export const createViewer = (url: string, cb: ViewerCallbacks): Viewer => (isMockEndpoint(url) ? new FakeViewer(cb) : new LiveKitViewer(cb));
