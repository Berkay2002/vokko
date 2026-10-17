// Mounted once with the app shell: it opens the viewer Room of the call we are in while that call has a Stremio session
// (viewerStore.ts) and closes it when either ends. The tiles never connect, whatever the layout does to them.

import { useEffect } from "react";
import { useVoice } from "../voice/store";
import { readViewerStats, setViewerOutput, syncViewer, useViewerStore } from "./viewerStore";

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
  const bot = useVoice(s => (s.channelId ? s.stremio[s.channelId]?.bot_identity : undefined));
  const deaf = useVoice(s => s.selfDeaf);
  const volume = useViewerStore(s => s.volume);

  useEffect(() => {
    setViewerOutput(deaf ? 0 : volume / 100);
  }, [deaf, volume]);

  useEffect(() => {
    syncViewer(channelId && bot ? { channelId, bot } : null);
  }, [channelId, bot]);

  useEffect(() => () => syncViewer(null), []);

  useEffect(() => {
    if (!channelId || !bot || !debugOn()) return;
    window.__vokkoStremio = { stats: readViewerStats };
    const timer = setInterval(() => void readViewerStats().then(s => s && console.info("[stremio] receive", s)), 5000);
    return () => {
      clearInterval(timer);
      delete window.__vokkoStremio;
    };
  }, [channelId, bot]);

  return null;
}
