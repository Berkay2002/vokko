// Mounted once with the app shell: it opens the viewer Room of the call we are in while that call has a Stremio or Spotify session
// (viewerStore.ts; at most one media activity per channel) and closes it when either ends. The tiles never connect, whatever the
// layout does to them.

import { useEffect } from "react";
import { PopoutHost, usePopoutStore } from "../popout";
import { useSpotifyVolume } from "../spotify/volume";
import { useVoice } from "../voice/store";
import { botOutput, readViewerStats, setViewerOutput, syncViewer, useViewerStore } from "./viewerStore";

const DEBUG_KEY = "vokko.stremio.debug";

declare global {
  interface Window {
    /** Set `localStorage["vokko.stremio.debug"]` and reload; `__vokkoStremio.stats()` then reads the picture's receive stats. */
    __vokkoStremio?: { stats: typeof readViewerStats };
  }
}

function debugOn(): boolean {
  try {
    return localStorage.getItem(DEBUG_KEY) !== null;
  } catch {
    return false;
  }
}

export function StremioViewerHost() {
  const channelId = useVoice(s => s.channelId);
  const stremioBot = useVoice(s => (s.channelId ? s.stremio[s.channelId]?.bot_identity : undefined));
  const spotifyBot = useVoice(s => (s.channelId ? s.spotify[s.channelId]?.bot_identity : undefined));
  const kind = stremioBot ? "stremio" : spotifyBot ? "spotify" : null;
  const bot = stremioBot ?? spotifyBot;
  const stremioVolume = useViewerStore(s => s.volume);
  const spotifyVolume = useSpotifyVolume(s => s.volume);
  const volume = kind === "spotify" ? spotifyVolume : stremioVolume;
  const output = useVoice(s => (kind ? botOutput(s, kind, volume) : 0));

  // Popped out: the pop-out window has its own Room and plays the movie; this one stays up for the cues and the state, and keeps quiet.
  const poppedOut = usePopoutStore(s => s.kind === "stremio" && s.channelId === channelId) && kind === "stremio";

  useEffect(() => {
    setViewerOutput(poppedOut ? 0 : output);
  }, [output, poppedOut]);

  useEffect(() => {
    syncViewer(channelId && bot && kind ? { channelId, bot, kind } : null);
  }, [channelId, bot, kind]);

  useEffect(() => () => syncViewer(null), []);

  useEffect(() => {
    if (!channelId || !stremioBot || !debugOn()) return;
    window.__vokkoStremio = { stats: readViewerStats };
    const timer = setInterval(() => void readViewerStats().then(s => s && console.info("[stremio] receive", s)), 5000);
    return () => {
      clearInterval(timer);
      delete window.__vokkoStremio;
    };
  }, [channelId, stremioBot]);

  return <PopoutHost />;
}
