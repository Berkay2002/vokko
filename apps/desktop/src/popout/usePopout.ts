// The call bar's Pop out button: what it says and does. Desktop: a window of the app (PopoutHost.tsx, src-tauri/src/popout.rs).
// Web: Document Picture-in-Picture, else the browser's video Picture-in-Picture for Stremio, else the button is disabled (webPip.tsx).

import { useVoice } from "../voice/store";
import { isDesktop } from "../desktop/tauri";
import type { Snowflake } from "../api/types";
import { popoutKind } from "./relay";
import { closePopout, openPopout, usePopoutStore, useWebPipStore } from "./store";
import { canDocumentPip, canVideoPip, closeWebPip, openWebPip } from "./webPip";

export interface PopoutButton {
  available: boolean;
  active: boolean;
  tooltip: string;
  toggle(): void;
}

export function usePopout(channelId: Snowflake): PopoutButton {
  const inCall = useVoice(s => s.channelId === channelId);
  const kind = useVoice(s => popoutKind({ stremio: s.stremio[channelId], watch: s.watch[channelId] }));
  const desktopOpen = usePopoutStore(s => s.channelId === channelId);
  const webOpen = useWebPipStore(s => s.channelId === channelId);
  const desktop = isDesktop();
  const active = desktop ? desktopOpen : webOpen;

  if (active) {
    return { available: true, active, tooltip: desktop ? "Close the pop-out" : "Close the Picture-in-Picture window", toggle: desktop ? closePopout : closeWebPip };
  }
  if (!inCall || !kind) return { available: false, active, tooltip: "Pop out (play Stremio or Watch Together in the call)", toggle: () => undefined };
  if (desktop) return { available: true, active, tooltip: "Pop out", toggle: () => void openPopout(channelId, kind) };
  if (canDocumentPip() || (kind === "stremio" && canVideoPip())) {
    return { available: true, active, tooltip: "Pop out", toggle: () => void openWebPip(channelId, kind).catch(() => undefined) };
  }
  return { available: false, active, tooltip: "Pop out (this browser has no Picture-in-Picture)", toggle: () => undefined };
}
