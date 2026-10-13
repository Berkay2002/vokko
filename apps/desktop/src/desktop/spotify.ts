import { call } from "./tauri";

/** What the Spotify desktop app on this computer is playing (read locally: AppleScript on macOS, the media session on Windows). */
export interface NowPlaying {
  title: string;
  artists: string[];
  album: string;
  /** Spotify track id (22 characters); macOS only. */
  track_id?: string | null;
  /** Spotify image id (40 hex) of the album art; macOS only. */
  image_id?: string | null;
  position_ms: number;
  duration_ms: number;
}

/** The track playing now; null when Spotify is not running, paused, on an ad or podcast, on another platform, or outside the desktop app. */
export function readNowPlaying(): Promise<NowPlaying | null> {
  return call<NowPlaying | null>("spotify_now_playing", undefined, null);
}
