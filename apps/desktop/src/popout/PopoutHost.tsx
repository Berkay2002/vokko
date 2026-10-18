// Main-window side of the Pop Out window: turns the call's Stremio / Watch Together session into one PopoutSession, sends it to the
// pop-out on every change, and runs what its buttons ask for (the same PATCHes and call actions the tile uses). Mounted once with the
// app shell (StremioViewerHost); desktop only, and idle (a store read) until a pop-out is open.

import { useEffect, useRef } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { appStore } from "../api/store";
import { controlStremio, viewerToken } from "../stremio/api";
import { reason } from "../stremio/format";
import { botOutput, setViewerVolume, useViewerStore } from "../stremio/viewerStore";
import { call, isDesktop, onDesktopEvent } from "../desktop/tauri";
import { dmPath, go, guildPath } from "../shell/nav";
import { leaveVoice, toggleSelfMute } from "../voice/engine";
import { useVoice } from "../voice/store";
import { skipAction, useCanControlMedia, useMeId } from "../voice/useCanControlMedia";
import { controlWatch } from "../watch/api";
import { ACTION_EVENT, CLOSED_EVENT, CUES_EVENT, READY_EVENT, SESSION_EVENT, TOKEN_EVENT, watchPatch, type CuesReply, type PopoutAction, type PopoutKind, type PopoutSession, type TokenReply } from "./protocol";
import { buildSession, patchFor } from "./relay";
import { closePopout, usePopoutStore } from "./store";
import { useAddonCues, usePick } from "./useAddonCues";
import { WebPipHost } from "./webPip";
import { POPOUT_WINDOW } from "./window";

export function PopoutHost() {
  return isDesktop() ? <DesktopPopoutHost /> : <WebPipHost />;
}

const send = (event: string, payload: unknown): void => void emitTo(POPOUT_WINDOW, event, payload).catch(() => undefined);

function DesktopPopoutHost() {
  const channelId = usePopoutStore(s => s.channelId);
  const kind = usePopoutStore(s => s.kind);
  useEffect(() => {
    // A pop-out left over from before this page reloaded (dev) has nobody to talk to.
    void call("desktop_popout_close", undefined, undefined);
    const stop = onDesktopEvent<null>(CLOSED_EVENT, () => usePopoutStore.setState({ channelId: null, kind: null }));
    return () => void stop.then(fn => fn());
  }, []);
  return channelId && kind ? <Relay key={channelId} channelId={channelId} kind={kind} /> : null;
}

function Relay({ channelId, kind }: { channelId: string; kind: PopoutKind }) {
  const inCall = useVoice(s => s.channelId === channelId);
  const stremio = useVoice(s => s.stremio[channelId]);
  const watch = useVoice(s => s.watch[channelId]);
  const muted = useVoice(s => s.selfMute || s.selfDeaf);
  const volume = useViewerStore(s => s.volume);
  const output = useVoice(s => botOutput(s, "stremio", volume));
  const meId = useMeId();
  const controller = useCanControlMedia(channelId, (kind === "stremio" ? stremio : watch)?.host_id);
  const pick = usePick(channelId, kind === "stremio" ? stremio : undefined);
  const addonCues = useAddonCues(channelId, pick);
  const skipLabel = watch ? skipAction(watch, meId, controller).label : "Skip";
  const session = inCall ? buildSession(kind, { channelId, controller, muted, stremio, watch, volume, output, pick, skipLabel }) : null;

  const latest = useRef<PopoutSession | null>(session);
  latest.current = session;
  const cues = useRef<CuesReply | null>(addonCues);
  cues.current = addonCues;
  const sent = useRef("");
  const json = session ? JSON.stringify(session) : "";

  useEffect(() => {
    if (!json) {
      // The call or the session ended: nothing left to show.
      closePopout();
      return;
    }
    if (json === sent.current) return;
    sent.current = json;
    send(SESSION_EVENT, latest.current);
  }, [json]);

  useEffect(() => {
    if (addonCues) send(CUES_EVENT, addonCues);
  }, [addonCues]);

  useEffect(() => {
    const stops = [
      onDesktopEvent<null>(READY_EVENT, () => {
        // The pop-out page (re)loaded: it has nothing yet.
        if (latest.current) {
          sent.current = JSON.stringify(latest.current);
          send(SESSION_EVENT, latest.current);
        }
        if (cues.current) send(CUES_EVENT, cues.current);
      }),
      onDesktopEvent<PopoutAction>(ACTION_EVENT, action => run(action, latest.current, channelId)),
    ];
    return () => stops.forEach(stop => void stop.then(fn => fn()));
  }, [channelId]);

  return null;
}

/** What a pop-out button asks for, done as the tile would. */
function run(action: PopoutAction, session: PopoutSession | null, channelId: string): void {
  if (!session) return;
  const ignore = () => undefined;
  switch (action.type) {
    case "token":
      void viewerToken(channelId)
        .then(({ url, token }): TokenReply => ({ id: action.id, url, token }))
        .catch((error: unknown): TokenReply => ({ id: action.id, error: reason(error) }))
        .then(reply => send(TOKEN_EVENT, reply));
      return;
    case "volume":
      if (Number.isFinite(action.value)) setViewerVolume(Math.min(100, Math.max(0, Math.round(action.value))));
      return;
    case "mute":
      toggleSelfMute();
      return;
    case "hangup":
      leaveVoice();
      return;
    case "back": {
      const guildId = appStore.getState().channels[channelId]?.guild_id ?? null;
      go(guildId ? guildPath(guildId, channelId) : dmPath(channelId));
      return;
    }
    case "skip":
      if (session.kind === "watch") {
        const skip = skipAction(session.state, appStore.getState().me?.id, session.controller);
        void controlWatch(channelId, { skip: skip.skip, video_id: session.state.video_id }).catch(ignore);
      }
      return;
    case "watch-patch": {
      const patch = session.kind === "watch" ? watchPatch(action.patch) : null;
      if (patch) void controlWatch(channelId, patch).catch(ignore);
      return;
    }
    default: {
      const patch = patchFor(action, session, Date.now());
      if (!patch) return;
      void (session.kind === "stremio" ? controlStremio(channelId, patch) : controlWatch(channelId, patch)).catch(ignore);
    }
  }
}
