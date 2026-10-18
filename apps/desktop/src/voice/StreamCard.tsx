// The "Streaming now" card that opens when you hover (or focus) a streaming user's row in the channel list: the live preview
// when we already receive their screen share, the game they are playing, and Watch Stream (joins the channel first if needed).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Gamepad2, Monitor } from "lucide-react";
import { formatClock } from "../activity/format";
import { appStore } from "../api/store";
import type { Snowflake } from "../api/types";
import { ActivityIcon } from "../shell/ActivityIcon";
import { useNow, usePlaying } from "../shell/ActivityLine";
import { SpotifyCard } from "../shell/SpotifyCard";
import type { Activity } from "../api/types";
import { go, guildPath } from "../shell/nav";
import { placeNear } from "../ui";
import { joinVoiceChannel, watchStream } from "./engine";
import { useVideo, type VideoHandle } from "./mediaStore";
import { getVoice, voiceStore } from "./store";
import { useVoiceUi } from "./uiStore";
import "./stream.css";

/** The small red "LIVE" pill (rows and the card header). */
export function LivePill({ className }: { className?: string }) {
  return <span className={`voice-live-pill${className ? ` ${className}` : ""}`}>LIVE</span>;
}

let pendingWatch: (() => void) | null = null;

/**
 * Watch `userId`'s stream in `channelId`: opens the voice channel page, joins it first when we are not in it, then starts
 * watching once the call in that channel is connected and requests focus for the streamer's stream tile: `requestStreamFocus`,
 * which the stage turns into `useVoiceUi.focusedTile`.
 */
export function watchStreamFrom(channelId: Snowflake, userId: Snowflake): void {
  const channel = appStore.getState().channels[channelId];
  if (!channel?.guild_id) return;
  pendingWatch?.();
  pendingWatch = null;
  const start = () => {
    watchStream(userId, true);
    useVoiceUi.getState().requestStreamFocus(userId);
  };
  const before = getVoice();
  if (before.channelId === channelId && !before.pendingJoin && before.status === "connected") {
    go(guildPath(channel.guild_id, channelId));
    return start();
  }
  if (before.channelId !== channelId && joinVoiceChannel(channel) !== null) return; // refused (full, no permission): the engine shows why
  go(guildPath(channel.guild_id, channelId));
  // A move keeps status "connected" (the old room) until the new token arrives, and the old room's subscriptions die with
  // it: wait for the media connection to drop and come back up in the new channel before watching.
  let dropped = getVoice().status !== "connected";
  const stop = voiceStore.subscribe(state => {
    if (state.channelId !== channelId) return cancel(); // left, refused, or moved somewhere else
    if (state.status !== "connected") dropped = true;
    else if (dropped && !state.pendingJoin) {
      cancel();
      start();
    }
  });
  const cancel = () => {
    stop();
    if (pendingWatch === cancel) pendingWatch = null;
  };
  pendingWatch = cancel;
}

function PreviewVideo({ handle }: { handle: VideoHandle }) {
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = element.current;
    if (!el) return;
    handle.attach(el);
    return () => handle.detach(el);
  }, [handle]);
  return <video ref={element} className="stream-card-video" autoPlay muted playsInline />;
}

function Elapsed({ start }: { start: number }) {
  const now = useNow(1000);
  return <span className="stream-card-elapsed">{formatClock(start, now)}</span>;
}

export interface StreamCardProps {
  anchor: HTMLElement | null;
  open: boolean;
  /** Bumped to move keyboard focus into the card (Watch Stream, or the card itself). */
  focusTick: number;
  /** Escape inside the card; also used after Watch Stream. */
  onDismiss: () => void;
  userId: Snowflake;
  channelId: Snowflake;
  name: string;
  /** Set when the row shows a song instead of a stream: the card is then the compact Spotify card. */
  listening?: Activity | null;
  /** Pointer enters / leaves the card (the row keeps it open across the gap). */
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  /** Focus leaves the card for somewhere that is neither the card nor the row. */
  onBlurOut: (next: Element | null) => void;
  boxRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * A plain portal rather than a `Popout`: a popout registers an overlay layer, which would take Escape from whatever has focus
 * (the composer) while the pointer merely rests on a row. Escape here is handled only when focus is in the card or the row.
 */
export function StreamCard({ anchor, open, focusTick, onDismiss, userId, channelId, name, listening, onPointerEnter, onPointerLeave, onBlurOut, boxRef }: StreamCardProps) {
  // Only shown when the stream is already coming in (we are watching it): subscribing just for a preview is not cheap.
  const screen = useVideo(userId, "screen");
  const own = voiceStore(s => s.meId === userId);
  const playing = usePlaying(userId);
  const start = playing?.timestamps?.start;
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const el = boxRef.current;
      if (!anchor || !el) return;
      const { left, top } = placeNear(anchor.getBoundingClientRect(), el.offsetWidth, el.offsetHeight, "right", 8, "start");
      setPos({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, boxRef, !!playing, !!screen]);

  // Focus waits for the first placement: until then the card is visibility: hidden, and hidden elements can't take focus
  // (ArrowRight on a row whose card was closed opens and focuses in one go).
  const focusWanted = useRef(0);
  const placed = pos !== null;
  useEffect(() => {
    if (!open || !placed || focusTick === focusWanted.current) return;
    focusWanted.current = focusTick;
    const el = boxRef.current;
    (el?.querySelector<HTMLElement>(".stream-card-watch, .spotify-play") ?? el)?.focus();
  }, [open, placed, focusTick, boxRef]);

  if (!open) return null;
  return createPortal(
    <div
      ref={boxRef}
      role="dialog"
      aria-label={listening ? `${name} is listening to Spotify` : `${name} is streaming`}
      tabIndex={-1}
      className="popout stream-card-popout stream-card"
      data-testid={listening ? "listen-card" : "stream-card"}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      onKeyDown={e => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }}
      onBlur={e => {
        const next = e.relatedTarget as Element | null;
        if (!next || !e.currentTarget.contains(next)) onBlurOut(next);
      }}
    >
      {listening ? (
        <SpotifyCard activity={listening} compact />
      ) : (
        <>
      <div className="stream-card-header">
        <span className="stream-card-heading">Streaming now</span>
        <LivePill />
      </div>
      <div className="stream-card-preview">
        {screen ? (
          <PreviewVideo handle={screen} />
        ) : (
          <span className="stream-card-placeholder" aria-hidden="true">
            <Monitor size={40} />
          </span>
        )}
      </div>
      {playing && (
        <div className="stream-card-activity" data-testid="stream-card-activity">
          <span className="stream-card-game-icon" aria-hidden="true">
            <ActivityIcon activity={playing} size={24} fill />
          </span>
          <span className="stream-card-activity-text">
            <span className="stream-card-game">{playing.name}</span>
            {start ? (
              <span className="stream-card-time">
                <Gamepad2 size={12} aria-hidden="true" className="stream-card-time-icon" />
                <Elapsed start={start} />
              </span>
            ) : null}
          </span>
        </div>
      )}
      {!own && (
        <button
          type="button"
          className="btn btn-success stream-card-watch"
          onClick={() => {
            onDismiss();
            watchStreamFrom(channelId, userId);
          }}
        >
          <Monitor size={18} aria-hidden="true" />
          Watch Stream
        </button>
      )}
        </>
      )}
    </div>,
    document.body,
  );
}
