// The Stremio tile: the bot's picture from the viewer Room (see ./viewer.ts), with the server's session state on top of it:
// poster and status before the picture arrives, a seek bar, play / pause, +-10 s, skip, stop, local volume and Up next.
// The server holds the truth ({status, playing, position_ms, updated_at_ms}); every button is a PATCH that comes back to everyone
// (this client included) as STREMIO_UPDATE. Volume is local and plays the movie's audio from the viewer Room.

import { useEffect, useRef, useState } from "react";
import { ListVideo, Maximize2, Minimize2, Pause, Play, Plus, RotateCcw, RotateCw, SkipForward, Square, Tv, Volume2, VolumeX, X } from "lucide-react";
import { displayName, useStore } from "../api/store";
import type { Snowflake, StremioState } from "../api/types";
import { Tooltip } from "../ui";
import { useVoice } from "../voice/store";
import { formatClock } from "../watch/youtube";
import { controlStremio, stopStremio } from "./api";
import { reason, safeImage, shownPositionMs, statusText } from "./format";
import { openStremioPanel } from "./panelStore";
import { useViewer } from "./useViewer";
import "./stremio.css";

export type StremioVariant = "solo" | "grid" | "focused" | "strip" | "pip";

const VOLUME_KEY = "vokko.stremio.volume";
const JUMP_MS = 10_000;

function readVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    const value = Number(raw);
    return raw !== null && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 60;
  } catch {
    return 60;
  }
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}


function ControlButton({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <Tooltip content={label} side="top">
      <button type="button" className={`stremio-button${active ? " active" : ""}`} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    </Tooltip>
  );
}

/** The `<video>` of the viewer Room's picture; the element belongs to React and the handle only attaches to it. */
function RoomVideo({ handle }: { handle: NonNullable<ReturnType<typeof useViewer>["video"]> }) {
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = element.current;
    if (!el) return;
    handle.attach(el);
    return () => handle.detach(el);
  }, [handle]);
  return <video ref={element} className="stremio-video" autoPlay muted playsInline data-source="stremio" />;
}

function QueuePanel({ channelId, queue, onAdd }: { channelId: Snowflake; queue: StremioState["queue"]; onAdd(): void }) {
  const users = useStore(s => s.users);
  const [error, setError] = useState<string | null>(null);
  const remove = (index: number) => {
    setError(null);
    controlStremio(channelId, { queue_remove: index }).catch(e => setError(reason(e)));
  };
  return (
    <aside className="stremio-queue" aria-label="Up next">
      <h3 className="stremio-queue-title">Up next</h3>
      {queue.length === 0 ? (
        <p className="stremio-queue-empty">Nothing queued.</p>
      ) : (
        <ol className="stremio-queue-list">
          {queue.map((item, i) => {
            const by = users[item.added_by];
            return (
              <li key={`${item.title}-${i}`} className="stremio-queue-item" data-title={item.title}>
                <span className="stremio-queue-text">
                  <span className="stremio-queue-name">{item.title}</span>
                  <span className="stremio-queue-sub">{[item.subtitle, by ? `added by ${displayName(by)}` : null].filter(Boolean).join(" · ")}</span>
                </span>
                <button type="button" className="stremio-button" aria-label={`Remove ${item.title} from Up next`} onClick={() => remove(i)}>
                  <X size={14} />
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <button type="button" className="btn btn-secondary stremio-queue-add" onClick={onAdd}>
        <Plus size={14} aria-hidden="true" /> Add to Up next
      </button>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </aside>
  );
}

/** The tile of the channel's session; nothing once it has ended. */
export function StremioTile(props: { channelId: Snowflake; variant: StremioVariant; onActivate?: () => void }) {
  const state = useVoice(s => s.stremio[props.channelId]);
  return state ? <StremioTileBody {...props} state={state} /> : null;
}

function StremioTileBody({ channelId, variant, onActivate, state }: { channelId: Snowflake; variant: StremioVariant; onActivate?: () => void; state: StremioState }) {
  const starter = useStore(s => s.users[state.started_by]);
  const inCall = useVoice(s => s.channelId === channelId);
  const deaf = useVoice(s => s.selfDeaf);
  const [volume, setVolume] = useState(readVolume);
  const [queueOpen, setQueueOpen] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const now = useNow(500);
  const viewer = useViewer(channelId, inCall, state.bot_identity, deaf ? 0 : volume / 100);

  const small = variant === "strip" || variant === "pip";
  const position = shownPositionMs(state, now);
  const duration = state.duration_ms ?? 0;
  const poster = safeImage(state.item.poster);
  const showPicture = viewer.video !== null && state.status !== "error";
  const status = showPicture && (state.status === "playing" || state.status === "paused") ? "" : statusText(state, viewer.room);
  const run = (promise: Promise<unknown>) => {
    setFailure(null);
    promise.catch(e => setFailure(reason(e)));
  };
  const seekTo = (ms: number) => run(controlStremio(channelId, { position_ms: Math.max(0, Math.min(Math.round(ms), duration || ms)) }));
  const changeVolume = (value: number) => {
    setVolume(value);
    try {
      localStorage.setItem(VOLUME_KEY, String(value));
    } catch {
      /* not saved */
    }
  };
  const commitSeek = () => {
    if (drag === null) return;
    seekTo(drag);
    setDrag(null);
  };
  const title = state.item.subtitle ? `${state.item.title}, ${state.item.subtitle}` : state.item.title;

  return (
    <div
      className={`voice-tile stremio ${variant}`}
      data-stremio-tile
      data-status={state.status}
      data-playing={state.playing}
      data-room={viewer.room}
      data-volume={deaf ? 0 : volume}
      role="group"
      aria-label={`Stremio: ${title}`}
    >
      {viewer.video && <RoomVideo handle={viewer.video} />}
      {!showPicture && poster && <img className="stremio-poster" src={poster} alt="" />}
      {status && (
        <div className="stremio-status" role="status">
          {status}
        </div>
      )}
      {small ? (
        <button type="button" className="stremio-cover" aria-label="Focus Stremio" onClick={onActivate}>
          <Tv size={variant === "pip" ? 20 : 24} aria-hidden="true" />
          <span className="stremio-cover-text">Watching {state.item.title} on Stremio</span>
        </button>
      ) : (
        <>
          <div className="stremio-head">
            <span className="stremio-title">
              {state.item.title} <span className="voice-bot-badge">Bot</span>
            </span>
            <span className="stremio-by">
              {[state.item.subtitle, state.item.label, starter ? `Started by ${displayName(starter)}` : null].filter(Boolean).join(" · ")}
            </span>
          </div>
          {(failure || viewer.blocked) && (
            <div className="stremio-notice" role="alert">
              {failure ?? "Your browser is holding back the sound."}
              {!failure && (
                <button type="button" className="btn btn-secondary" onClick={viewer.startAudio}>
                  Turn on sound
                </button>
              )}
            </div>
          )}
          {queueOpen && <QueuePanel channelId={channelId} queue={state.queue} onAdd={openStremioPanel} />}
          <div className="stremio-bar">
            <input
              className="stremio-seek"
              type="range"
              aria-label="Seek"
              min={0}
              max={Math.max(duration, 1)}
              step={1000}
              value={drag ?? position}
              disabled={duration === 0 || state.status === "error"}
              onChange={e => setDrag(Number(e.target.value))}
              onPointerUp={commitSeek}
              onKeyUp={commitSeek}
              onBlur={commitSeek}
            />
            <div className="stremio-controls">
              <ControlButton label={state.playing ? "Pause" : "Play"} disabled={state.status === "error"} onClick={() => run(controlStremio(channelId, { playing: !state.playing }))}>
                {state.playing ? <Pause size={18} /> : <Play size={18} />}
              </ControlButton>
              <ControlButton label="Back 10 seconds" disabled={duration === 0} onClick={() => seekTo(position - JUMP_MS)}>
                <RotateCcw size={18} />
              </ControlButton>
              <ControlButton label="Forward 10 seconds" disabled={duration === 0} onClick={() => seekTo(position + JUMP_MS)}>
                <RotateCw size={18} />
              </ControlButton>
              <ControlButton label={state.queue.length > 0 ? "Skip to next" : "Skip and stop"} onClick={() => run(controlStremio(channelId, { skip: true }))}>
                <SkipForward size={18} />
              </ControlButton>
              <span className="stremio-time" aria-label="Position">
                {formatClock(drag ?? position)}
                {duration > 0 && ` / ${formatClock(duration)}`}
              </span>
              <span className="stremio-spacer" />
              <label className="stremio-volume">
                {volume === 0 || deaf ? <VolumeX size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
                <input type="range" aria-label="Stremio volume" min={0} max={100} value={volume} onChange={e => changeVolume(Number(e.target.value))} />
              </label>
              <ControlButton label={`Up next (${state.queue.length})`} active={queueOpen} onClick={() => setQueueOpen(o => !o)}>
                <ListVideo size={18} />
              </ControlButton>
              {onActivate && (
                <ControlButton label={variant === "focused" ? "Back to grid" : "Focus Stremio"} onClick={onActivate}>
                  {variant === "focused" ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                </ControlButton>
              )}
              <ControlButton label="Stop Stremio" onClick={() => run(stopStremio(channelId))}>
                <Square size={18} />
              </ControlButton>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
