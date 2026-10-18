// The Stremio tile: the bot's picture from the viewer Room (see ./viewer.ts), with the server's session state on top of it:
// poster and status before the picture arrives, a seek bar, play / pause, +-10 s, skip, stop, local volume and Up next.
// The server holds the truth ({status, playing, position_ms, updated_at_ms}); every button is a PATCH that comes back to everyone
// (this client included) as STREMIO_UPDATE. Volume is local and plays the movie's audio from the viewer Room. Someone without
// control (useCanControlMedia) sees no play / pause, seek, +-10 s or stop, votes to skip, and removes only their own Up next entries.

import { useEffect, useReducer, useRef, useState } from "react";
import { useNow } from "../shell/ActivityLine";
import { ListVideo, Maximize2, Minimize2, Pause, Play, Plus, RotateCcw, RotateCw, SkipForward, Square, Volume2, VolumeX, X } from "lucide-react";
import { displayName, useStore } from "../api/store";
import { STREMIO_QUEUE_PER_USER, type Snowflake, type StremioState } from "../api/types";
import { Tooltip, useContextMenu } from "../ui";
import { MediaVotes, useHostLabel } from "../voice/MediaVotes";
import { useVoice } from "../voice/store";
import { volumeMenuItems } from "../voice/voiceMenus";
import { queueQuota, skipAction, useCanControlMedia, useMeId } from "../voice/useCanControlMedia";
import { formatClock } from "../watch/youtube";
import { controlStremio, stopStremio } from "./api";
import { reason, safeImage, shownPositionMs, statusText } from "./format";
import { LanguagesMenu } from "./Languages";
import { StremioIcon } from "./StremioIcon";
import { openStremioPanel } from "./panelStore";
import { PosterImage } from "./PosterImage";
import { SeekCoalescer } from "./seek";
import { botVolumeKey, setViewerVolume, startViewerAudio, useViewerSlot, useViewerStore } from "./viewerStore";
import type { VideoHandle } from "../voice/mediaStore";
import "./stremio.css";

export type StremioVariant = "solo" | "grid" | "focused" | "strip" | "pip";

const JUMP_MS = 10_000;


function ControlButton({ label, tip, active, disabled, onClick, children }: { label: string; tip?: string; active?: boolean; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <Tooltip content={tip ?? label} side="top">
      <button type="button" className={`stremio-button${active ? " active" : ""}`} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    </Tooltip>
  );
}

/** The `<video>` of the viewer Room's picture; the element belongs to React and the handle only attaches to it. */
function RoomVideo({ handle }: { handle: VideoHandle }) {
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = element.current;
    if (!el) return;
    handle.attach(el);
    return () => handle.detach(el);
  }, [handle]);
  return <video ref={element} className="stremio-video" autoPlay muted playsInline data-source="stremio" />;
}

function QueuePanel({ channelId, queue, onAdd, controller, meId }: { channelId: Snowflake; queue: StremioState["queue"]; onAdd(): void; controller: boolean; meId: Snowflake | undefined }) {
  const users = useStore(s => s.users);
  const quota = queueQuota(queue.map(q => q.added_by), meId, controller, STREMIO_QUEUE_PER_USER);
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
                <span className="stremio-queue-art"><PosterImage src={safeImage(item.poster)} /></span>
                <span className="stremio-queue-text">
                  <span className="stremio-queue-name">{item.title}</span>
                  <span className="stremio-queue-sub">{[item.subtitle, by ? `added by ${displayName(by)}` : null].filter(Boolean).join(" · ")}</span>
                </span>
                {(controller || item.added_by === meId) && (
                  <button type="button" className="stremio-button" aria-label={`Remove ${item.title} from Up next`} onClick={() => remove(i)}>
                    <X size={14} />
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <button type="button" className="btn btn-secondary stremio-queue-add" disabled={quota?.full} onClick={onAdd}>
        <Plus size={14} aria-hidden="true" /> Add to Up next
      </button>
      {quota && (
        <p className="media-quota" data-queue-quota={quota.mine}>
          {quota.hint}
        </p>
      )}
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
  const hostLabel = useHostLabel(state, state.started_by);
  const meId = useMeId();
  const controller = useCanControlMedia(channelId, state.host_id);
  const skip = skipAction(state, meId, controller, state.queue.length > 0 ? "Skip to next" : "Skip and stop");
  const deaf = useVoice(s => s.selfDeaf);
  const volume = useViewerStore(s => s.volume);
  const [queueOpen, setQueueOpen] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const now = useNow(500);
  const viewer = useViewerSlot(channelId);
  const menu = useContextMenu();
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const id = useRef(channelId);
  id.current = channelId;
  const [seeker] = useState(
    () => new SeekCoalescer(ms => controlStremio(id.current, { position_ms: ms }), redraw, e => setFailure(reason(e))),
  );
  useEffect(() => () => seeker.flushNow(), [seeker]);

  const small = variant === "strip" || variant === "pip";
  const position = seeker.target ?? shownPositionMs(state, now);
  const duration = state.duration_ms ?? 0;
  // The picture trails the bot's position by the playout buffer while it plays (a pause lets the frozen frame catch up), so text cues wait the same.
  const cuePosition = Math.max(0, position - (state.playing && state.status === "playing" ? viewer.delayMs : 0));
  const poster = safeImage(state.item.poster);
  const showPicture = viewer.video !== null && state.status !== "error";
  const status = showPicture && (state.status === "playing" || state.status === "paused") ? "" : statusText(state, viewer.room);
  const run = (promise: Promise<unknown>) => {
    setFailure(null);
    promise.catch(e => setFailure(reason(e)));
  };
  const jump = (delta: number) => {
    setFailure(null);
    seeker.nudge(delta, position, 0, duration || Number.POSITIVE_INFINITY);
  };
  const commitSeek = () => {
    if (drag === null) return;
    setFailure(null);
    seeker.seek(Math.round(drag), true);
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
      onContextMenu={e => menu.open(e, volumeMenuItems(botVolumeKey("stremio")))}
    >
      {viewer.video && <RoomVideo handle={viewer.video} />}
      {!showPicture && <PosterImage className="stremio-poster" src={poster} />}
      {status && (
        <div className="stremio-status" role="status">
          {status}
        </div>
      )}
      {small ? (
        <button type="button" className="stremio-cover" aria-label="Focus Stremio" onClick={onActivate}>
          <StremioIcon size={variant === "pip" ? 20 : 24} />
          <span className="stremio-cover-text">Watching {state.item.title} on Stremio</span>
        </button>
      ) : (
        <>
          <div className="stremio-head">
            <span className="stremio-title">
              {state.item.title} <span className="voice-bot-badge">Bot</span>
            </span>
            <span className="stremio-by">
              {[state.item.subtitle, state.item.label, starter ? `Started by ${displayName(starter)}` : null, hostLabel].filter(Boolean).join(" · ")}
            </span>
            <MediaVotes control={state} />
          </div>
          {(failure || viewer.blocked) && (
            <div className="stremio-notice" role="alert">
              {failure ?? "Your browser is holding back the sound."}
              {!failure && (
                <button type="button" className="btn btn-secondary" onClick={startViewerAudio}>
                  Turn on sound
                </button>
              )}
            </div>
          )}
          {queueOpen && <QueuePanel channelId={channelId} queue={state.queue} onAdd={openStremioPanel} controller={controller} meId={meId} />}
          <div className="stremio-bar">
            {controller && (
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
            )}
            <div className="stremio-controls">
              {controller && (
                <>
                  <ControlButton label={state.playing ? "Pause" : "Play"} disabled={state.status === "error"} onClick={() => run(controlStremio(channelId, { playing: !state.playing }))}>
                    {state.playing ? <Pause size={18} /> : <Play size={18} />}
                  </ControlButton>
                  <ControlButton label="Back 10 seconds" disabled={duration === 0} onClick={() => jump(-JUMP_MS)}>
                    <RotateCcw size={18} />
                  </ControlButton>
                  <ControlButton label="Forward 10 seconds" disabled={duration === 0} onClick={() => jump(JUMP_MS)}>
                    <RotateCw size={18} />
                  </ControlButton>
                </>
              )}
              <ControlButton label={skip.label} tip={skip.vote ? `${skip.label}: skips when half the listeners vote` : undefined} active={skip.vote ? skip.voted : undefined} onClick={() => run(controlStremio(channelId, { skip: skip.skip, item_seq: state.item_seq }))}>
                <SkipForward size={18} />
                {skip.vote && <span className="media-vote-count">{state.skip_votes.length}/{state.skip_needed}</span>}
              </ControlButton>
              <span className="stremio-time" aria-label="Position">
                {formatClock(drag ?? position)}
                {duration > 0 && ` / ${formatClock(duration)}`}
              </span>
              <span className="stremio-spacer" />
              <label className="stremio-volume">
                {volume === 0 || deaf ? <VolumeX size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
                <input type="range" aria-label="Stremio volume" min={0} max={100} value={volume} onChange={e => setViewerVolume(Number(e.target.value))} />
              </label>
              <LanguagesMenu channelId={channelId} state={state} positionMs={cuePosition} controller={controller} />
              <ControlButton label={`Up next (${state.queue.length})`} active={queueOpen} onClick={() => setQueueOpen(o => !o)}>
                <ListVideo size={18} />
              </ControlButton>
              {onActivate && (
                <ControlButton label={variant === "focused" ? "Back to grid" : "Focus Stremio"} onClick={onActivate}>
                  {variant === "focused" ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                </ControlButton>
              )}
              {controller && (
                <ControlButton label="Stop Stremio" onClick={() => run(stopStremio(channelId))}>
                  <Square size={18} />
                </ControlButton>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
