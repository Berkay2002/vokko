// Pop Out on the web: Document Picture-in-Picture (Chromium) shows a second copy of the call's tile in a small always-on-top window of
// the browser; a Stremio movie falls back to the browser's video Picture-in-Picture. The page keeps running, so the tile copy lives in
// the page and is portalled into the PiP document (the Watch Together tile in the page goes quiet while the copy plays: useQuiet).

import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { Snowflake } from "../api/types";
import { StremioTile } from "../stremio/StremioTile";
import { useVoice } from "../voice/store";
import { WatchTile } from "../watch/WatchTile";
import type { PopoutKind } from "./protocol";
import { PipSurface, useWebPipStore } from "./store";

interface PipApi {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
}

const docPip = (): PipApi | null => (typeof window === "undefined" ? null : ((window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture ?? null));

export const canDocumentPip = (): boolean => docPip() !== null;
/** The browser's video Picture-in-Picture: the Stremio picture only (a Watch Together player is an iframe of YouTube's). */
export const canVideoPip = (): boolean => typeof document !== "undefined" && document.pictureInPictureEnabled === true;

const clear = () => useWebPipStore.setState({ channelId: null, kind: null, win: null });

/** Copies the page's styles and theme into the PiP document so the tile looks as it does in the page. */
function copyStyles(from: Document, to: Document): void {
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const style = to.createElement("style");
      style.textContent = Array.from(sheet.cssRules, rule => rule.cssText).join("\n");
      to.head.append(style);
    } catch {
      if (!sheet.href) continue;
      const link = to.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      to.head.append(link);
    }
  }
  for (const { name, value } of Array.from(from.documentElement.attributes)) to.documentElement.setAttribute(name, value);
  const fit = to.createElement("style");
  fit.textContent = "html,body{margin:0;height:100%;background:#000;overflow:hidden}#vokko-pip{display:flex;align-items:center;justify-content:center;width:100%;height:100%;container-type:size}";
  to.head.append(fit);
}

/** Must run inside the click: the browser only opens the window for a user gesture. */
export async function openWebPip(channelId: Snowflake, kind: PopoutKind): Promise<void> {
  const api = docPip();
  if (api) {
    const win = await api.requestWindow({ width: 480, height: 270 });
    copyStyles(document, win.document);
    const host = win.document.createElement("div");
    host.id = "vokko-pip";
    win.document.body.append(host);
    useWebPipStore.setState({ channelId, kind, win });
    win.addEventListener("pagehide", clear, { once: true });
    return;
  }
  if (kind !== "stremio" || !canVideoPip()) return;
  const video = document.querySelector<HTMLVideoElement>("video[data-source='stremio']");
  if (!video) return;
  await video.requestPictureInPicture();
  useWebPipStore.setState({ channelId, kind, win: null });
  video.addEventListener("leavepictureinpicture", clear, { once: true });
}

export function closeWebPip(): void {
  const { win } = useWebPipStore.getState();
  if (win) win.close();
  else if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
  clear();
}

/** Renders the tile copy into the PiP window while it is open; closes the window when the call or the session ends. */
export function WebPipHost() {
  const win = useWebPipStore(s => s.win);
  const channelId = useWebPipStore(s => s.channelId);
  const kind = useWebPipStore(s => s.kind);
  const alive = useVoice(s => channelId !== null && s.channelId === channelId && (kind === "stremio" ? !!s.stremio[channelId] : !!s.watch[channelId]));
  useEffect(() => {
    if (channelId && !alive) closeWebPip();
  }, [channelId, alive]);
  const host = win?.document.getElementById("vokko-pip");
  if (!host || !channelId || !alive) return null;
  return createPortal(
    <PipSurface.Provider value={true}>{kind === "stremio" ? <StremioTile channelId={channelId} variant="solo" /> : <WatchTile channelId={channelId} variant="solo" />}</PipSurface.Provider>,
    host,
  );
}
