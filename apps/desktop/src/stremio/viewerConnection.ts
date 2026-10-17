// One call's viewer Room with its retries: it connects as soon as it is made and disconnects on close(). Keyed by the caller on
// (channel, bot) only: a pause or seek must never reconnect. viewerStore.ts owns the single instance of a call. `kind` picks the
// token route: a channel has at most one media activity (Stremio or Spotify), and both play through this one Room.

import type { Snowflake } from "../api/types";
import type { VideoHandle } from "../voice/mediaStore";
import { isMockEndpoint } from "../voice/transport";
import { listenerToken } from "../spotify/api";
import { viewerToken } from "./api";
import type { Viewer } from "./viewer";
import type { VideoStats } from "./viewerStats";

/** "unsupported": the webview has no WebRTC (the Linux app's WebKitGTK), so the Room can never connect and is not retried. */
export type RoomState = "connecting" | "connected" | "closed" | "failed" | "unsupported";
export type MediaKind = "stremio" | "spotify";

export interface ConnectionHooks {
  room(state: RoomState): void;
  video(handle: VideoHandle | null): void;
  blocked(blocked: boolean): void;
}

const RETRY_MS = [1500, 4000, 10000];

export class ViewerConnection {
  private viewer: Viewer | null = null;
  private closed = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly channelId: Snowflake,
    private readonly botIdentity: string,
    private readonly kind: MediaKind,
    private volume: number,
    private readonly hooks: ConnectionHooks,
  ) {
    hooks.room("connecting");
    void this.open();
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.viewer?.setVolume(volume);
  }

  startAudio(): void {
    this.viewer?.startAudio();
  }

  async stats(): Promise<VideoStats | null> {
    return (await this.viewer?.stats()) ?? null;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.viewer?.disconnect();
    this.viewer = null;
    this.hooks.video(null);
    this.hooks.blocked(false);
  }

  private retry(): void {
    if (this.closed) return;
    const wait = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)] ?? 10000;
    this.attempt += 1;
    this.timer = setTimeout(() => void this.open(), wait);
  }

  private async open(): Promise<void> {
    let current: Viewer | null = null;
    try {
      const { url, token } = await (this.kind === "spotify" ? listenerToken : viewerToken)(this.channelId);
      if (!isMockEndpoint(url) && typeof RTCPeerConnection === "undefined") {
        if (!this.closed) this.hooks.room("unsupported");
        return;
      }
      // Lazy: viewer.ts pulls in livekit-client, which the first screen must not download.
      const { createViewer } = await import("./viewer");
      if (this.closed) return;
      const old = this.viewer;
      this.viewer = null;
      old?.disconnect();
      current = createViewer(url, {
        status: s => {
          if (this.closed || this.viewer !== current) return;
          if (s === "connected") this.attempt = 0;
          this.hooks.room(s);
          if (s === "closed") this.retry();
        },
        video: h => {
          if (!this.closed && this.viewer === current) this.hooks.video(h);
        },
        audioBlocked: b => {
          if (!this.closed && this.viewer === current) this.hooks.blocked(b);
        },
      });
      this.viewer = current;
      current.setVolume(this.volume);
      await current.connect(url, token, this.botIdentity);
    } catch {
      if (this.closed) return;
      if (this.viewer === current) this.viewer = null;
      current?.disconnect();
      this.hooks.room("failed");
      this.retry();
    }
  }
}
