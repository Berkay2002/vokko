// The Pop Out window's page (popout.html, created by src-tauri/src/popout.rs): the movie (or the Watch Together player) with controls that
// show on hover. No gateway, stores or login: it draws the session the main window sends (SESSION_EVENT) and sends its buttons back
// (ACTION_EVENT). A MediaStreamTrack cannot cross webviews, so the Stremio picture comes from this window's own subscribe-only Room.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { Mic, MicOff, Pause, Pin, PinOff, PhoneOff, Play, SkipForward, Undo2, Volume2, VolumeX, X } from "lucide-react";
import type { StremioCue, WatchTogetherPatchRequest } from "../api/types";
import { safeImage, shownPositionMs, statusText } from "../stremio/format";
import { PosterImage } from "../stremio/PosterImage";
import { activeCue, addCue, itemKey, onCues, subtitleTopic } from "../stremio/subtitles";
import { ViewerConnection, type RoomState } from "../stremio/viewerConnection";
import type { VideoHandle } from "../voice/mediaStore";
import { EMBED_URL } from "../watch/embed";
import { VOLUME_KEY, readVolume, useWatchPlayer } from "../watch/WatchTile";
import { expectedPositionMs, formatClock } from "../watch/youtube";
import { ACTION_EVENT, CUES_EVENT, READY_EVENT, SESSION_EVENT, type CuesReply, type PopoutAction, type PopoutSession, type StremioSession, type WatchSession } from "./protocol";
import { cuePositionMs } from "./relay";
import { popoutKeyAction } from "./keys";
import { requestToken } from "./tokens";
import { backToCall, closeWindow, setPinned } from "./window";

const act = (action: PopoutAction): void => void emit(ACTION_EVENT, action).catch(() => undefined);

function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export function PopoutPage() {
  const [session, setSession] = useState<PopoutSession | null>(null);
  const [addon, setAddon] = useState<CuesReply | null>(null);

  useEffect(() => {
    const stops = [listen<PopoutSession>(SESSION_EVENT, e => setSession(e.payload)), listen<CuesReply>(CUES_EVENT, e => setAddon(e.payload))];
    void Promise.all(stops).then(() => emit(READY_EVENT, null));
    return () => stops.forEach(stop => void stop.then(fn => fn()));
  }, []);

  const controller = session?.controller ?? false;
  const playing = session?.state.playing ?? false;
  useEffect(() => {
    if (!session) return;
    const down = (event: KeyboardEvent) => {
      const action = popoutKeyAction(event, controller, playing);
      if (!action) return;
      event.preventDefault();
      act(action);
    };
    // A button or slider that was clicked keeps focus, and Space on a focused button is that button's click, not play / pause: let go of it.
    const release = () => (document.activeElement as HTMLElement | null)?.blur();
    window.addEventListener("keydown", down);
    window.addEventListener("pointerup", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("pointerup", release);
    };
  }, [session !== null, controller, playing]); // eslint-disable-line react-hooks/exhaustive-deps -- only these matter to the handlers

  if (!session) return <div className="po-root" data-tauri-drag-region><div className="po-wait">Connecting…</div></div>;
  return session.kind === "stremio" ? <StremioPopout key={session.channelId} session={session} addon={addon} /> : <WatchPopout key={session.channelId} session={session} />;
}

// ---- the movie ----

function RoomVideo({ handle }: { handle: VideoHandle }) {
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = element.current;
    if (!el) return;
    handle.attach(el);
    return () => handle.detach(el);
  }, [handle]);
  return <video ref={element} className="po-video" autoPlay muted playsInline />;
}

function StremioPopout({ session, addon }: { session: StremioSession; addon: CuesReply | null }) {
  const { state, channelId, pick } = session;
  const now = useTick(250);
  const [room, setRoom] = useState<RoomState>("connecting");
  const [video, setVideo] = useState<VideoHandle | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [delay, setDelay] = useState(0);
  const [cues, setCues] = useState<StremioCue[]>([]);
  const connection = useRef<ViewerConnection | null>(null);
  const output = useRef(session.output);
  output.current = session.output;

  useEffect(() => {
    const next = new ViewerConnection(channelId, state.bot_identity, "stremio", output.current, { room: setRoom, video: setVideo, blocked: setBlocked, delay: setDelay }, requestToken);
    connection.current = next;
    return () => {
      next.close();
      connection.current = null;
    };
  }, [channelId, state.bot_identity]);

  useEffect(() => connection.current?.setVolume(session.output), [session.output]);

  // The browser holds sound back until the window is used once; any press is that use.
  useEffect(() => {
    if (!blocked) return;
    const start = () => connection.current?.startAudio();
    window.addEventListener("pointerdown", start);
    return () => window.removeEventListener("pointerdown", start);
  }, [blocked]);

  // Embedded subtitles arrive as data in this window's own Room; an addon's come from the main window (`addon`).
  const item = itemKey(state);
  const embedded = pick?.kind === "text" ? pick.id : -1;
  useEffect(() => {
    setCues([]);
    if (embedded < 0) return;
    const topic = subtitleTopic(embedded);
    return onCues(state.bot_identity, (t, cue) => t === topic && setCues(list => addCue(list, cue)));
  }, [embedded, item, state.bot_identity]);

  const list = pick?.kind === "addon" ? (addon?.sid === pick.sid ? addon.cues : []) : cues;
  const cue = pick ? activeCue(list, cuePositionMs(state, now, delay)) : undefined;

  const position = shownPositionMs(state, now);
  const duration = state.duration_ms ?? 0;
  const showPicture = video !== null && state.status !== "error";
  const status = showPicture && (state.status === "playing" || state.status === "paused") ? "" : statusText(state, room);
  const title = state.item.subtitle ? `${state.item.title}, ${state.item.subtitle}` : state.item.title;

  return (
    <Frame
      title={title}
      cue={cue?.text}
      progress={duration ? position / duration : 0}
      soundBlocked={blocked}
      onSound={() => connection.current?.startAudio()}
      bar={
        <Bar
          controller={session.controller}
          playing={state.playing}
          position={position}
          duration={duration}
          muted={session.muted}
          volume={session.volume}
          onVolume={value => act({ type: "volume", value })}
          disabled={state.status === "error"}
        />
      }
    >
      {video && <RoomVideo handle={video} />}
      {!showPicture && <PosterImage className="po-poster" src={safeImage(state.item.poster)} />}
      {status && <div className="po-status" role="status">{status}</div>}
    </Frame>
  );
}

// ---- Watch Together ----

const control = (_channelId: string, patch: WatchTogetherPatchRequest): Promise<void> => emit(ACTION_EVENT, { type: "watch-patch", patch } satisfies PopoutAction);

function WatchPopout({ session }: { session: WatchSession }) {
  const { state } = session;
  const now = useTick(250);
  const [volume, setVolume] = useState(readVolume);
  const player = useWatchPlayer(session.channelId, state, volume, control);
  const position = Math.min(expectedPositionMs(state, now), player.durationMs || Infinity);
  const duration = player.durationMs;
  const changeVolume = (value: number) => {
    setVolume(value);
    try {
      localStorage.setItem(VOLUME_KEY, String(value));
    } catch {
      /* not saved */
    }
  };

  return (
    <Frame
      title={state.title || "YouTube video"}
      pill="Watch Together"
      progress={duration ? position / duration : 0}
      bar={
        <Bar
          controller={session.controller}
          playing={state.playing}
          position={position}
          duration={duration}
          muted={session.muted}
          volume={volume}
          onVolume={changeVolume}
          skip={session.skipLabel}
          disabled={player.errorCode !== null}
        />
      }
    >
      <iframe ref={player.frame} className="po-embed" src={EMBED_URL} title="Watch Together player" tabIndex={-1} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" referrerPolicy="strict-origin-when-cross-origin" onLoad={player.onLoad} />
      {player.errorCode !== null && <div className="po-status" role="status">This video can't be played here.</div>}
    </Frame>
  );
}

// ---- the chrome: shows on hover, a thin progress line when idle ----

function Frame({ title, pill, cue, progress, soundBlocked, onSound, bar, children }: { title: string; pill?: string; cue?: string | undefined; progress: number; soundBlocked?: boolean; onSound?: () => void; bar: ReactNode; children: ReactNode }) {
  // Starts pinned every time (the window is created always on top); the choice is not remembered.
  const [pinned, setPin] = useState(true);
  const togglePin = () => {
    setPin(!pinned);
    void setPinned(!pinned);
  };
  const back = () => {
    act({ type: "back" });
    void backToCall();
  };
  return (
    <div className="po-root" data-tauri-drag-region>
      {children}
      {cue && (
        <div className="po-cue" data-testid="popout-cue">
          <span>{cue}</span>
        </div>
      )}
      <div className="po-line" aria-hidden="true">
        <div style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 1000) / 10}%` }} />
      </div>
      <div className="po-top" data-tauri-drag-region>
        <span className="po-title" data-tauri-drag-region>{title}</span>
        {pill && <span className="po-pill">{pill}</span>}
        <button type="button" className="po-icon" aria-label={pinned ? "Unpin: let other windows cover it" : "Pin on top"} aria-pressed={pinned} title={pinned ? "Pinned on top" : "Pin on top"} onClick={togglePin}>
          {pinned ? <Pin size={16} /> : <PinOff size={16} />}
        </button>
        <button type="button" className="po-icon" aria-label="Back to call" title="Back to call" onClick={back}>
          <Undo2 size={16} />
        </button>
        <button type="button" className="po-icon" aria-label="Close pop out" title="Close" onClick={() => void closeWindow()}>
          <X size={16} />
        </button>
      </div>
      {soundBlocked && (
        <button type="button" className="po-sound" onClick={onSound}>
          Turn on sound
        </button>
      )}
      <div className="po-bottom" data-tauri-drag-region>
        {bar}
      </div>
    </div>
  );
}

function Bar({ controller, playing, position, duration, muted, volume, onVolume, skip, disabled }: { controller: boolean; playing: boolean; position: number; duration: number; muted: boolean; volume: number; onVolume(value: number): void; skip?: string; disabled?: boolean }) {
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? position;
  const fill = duration ? Math.min(100, Math.max(0, (shown / duration) * 100)) : 0;
  const commit = () => {
    if (drag === null) return;
    act({ type: "seek", ms: Math.round(drag) });
    setDrag(null);
  };
  return (
    <>
      {controller && (
        <button type="button" className="po-icon po-play" aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause" : "Play"} disabled={disabled} onClick={() => act({ type: "playing", on: !playing })}>
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
      )}
      {skip && (
        <button type="button" className="po-icon" aria-label={skip} title={skip} onClick={() => act({ type: "skip" })}>
          <SkipForward size={18} />
        </button>
      )}
      {controller ? (
        <input
          className="po-range po-seek"
          type="range"
          aria-label="Seek"
          min={0}
          max={Math.max(duration, 1)}
          step={1000}
          value={shown}
          disabled={duration === 0 || disabled}
          style={{ "--po-fill": `${fill}%` } as CSSProperties}
          onChange={e => setDrag(Number(e.target.value))}
          onPointerUp={commit}
          onPointerCancel={() => setDrag(null)}
          onKeyUp={commit}
        />
      ) : (
        <div className="po-range po-seek po-readonly" role="progressbar" aria-label="Progress" aria-valuenow={Math.round(fill)} style={{ "--po-fill": `${fill}%` } as CSSProperties} />
      )}
      <span className="po-time" aria-label="Position">
        {formatClock(shown)}
        {duration > 0 && ` / ${formatClock(duration)}`}
      </span>
      <label className="po-volume" title="Volume">
        {volume === 0 ? <VolumeX size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
        <input
          className="po-range"
          type="range"
          aria-label="Volume"
          min={0}
          max={100}
          value={volume}
          style={{ "--po-fill": `${volume}%` } as CSSProperties}
          onChange={e => onVolume(Number(e.target.value))}
        />
      </label>
      <button type="button" className="po-icon" aria-label={muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={muted} title={muted ? "Unmute" : "Mute"} onClick={() => act({ type: "mute" })}>
        {muted ? <MicOff size={18} /> : <Mic size={18} />}
      </button>
      <button type="button" className="po-icon po-leave" aria-label="Leave call" title="Leave call" onClick={() => act({ type: "hangup" })}>
        <PhoneOff size={18} />
      </button>
    </>
  );
}
