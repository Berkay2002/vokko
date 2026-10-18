// The Watch Together tile: the shared YouTube player (an iframe on our own embed page) with its control bar and "Up next" queue.
// The server holds the truth ({video_id, playing, position_ms, updated_at_ms}); every client turns that into player commands,
// seeks when it drifts more than 2 s, and sends its own button presses back as PATCHes, which everyone (itself included) then
// applies from WATCH_TOGETHER_UPDATE. Volume is local. Someone without control (useCanControlMedia) sees no play / pause, seek or
// stop, votes to skip, and may queue up to WATCH_TOGETHER_QUEUE_PER_USER videos and take their own back out.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNow } from "../shell/ActivityLine";
import { ListVideo, Maximize2, Minimize2, Pause, Play, SkipForward, Square, Tv, Volume2, VolumeX, X } from "lucide-react";
import { displayName, useStore } from "../api/store";
import { WATCH_TOGETHER_QUEUE_PER_USER, type Snowflake, type WatchTogetherPatchRequest, type WatchTogetherState } from "../api/types";
import { useQuiet } from "../popout/store";
import { reason } from "../stremio/format";
import { Tooltip } from "../ui";
import { MediaVotes, useHostLabel } from "../voice/MediaVotes";
import { useVoice } from "../voice/store";
import { queueQuota, skipAction, useCanControlMedia, useMeId } from "../voice/useCanControlMedia";
import { controlWatch, stopWatch } from "./api";
import { EMBED_URL, parseEmbedMessage, sendToEmbed, type EmbedCommand, type PlayerState } from "./embed";
import { DRIFT_MS, expectedPositionMs, formatClock, needsSeek, parseYouTubeLink } from "./youtube";
import "./watch.css";

export type WatchVariant = "solo" | "grid" | "focused" | "strip" | "pip";
export type WatchControl = (channelId: Snowflake, patch: WatchTogetherPatchRequest) => Promise<unknown>;

/** A state change someone made moves the player to within this of the shared position; the 2 s drift check handles the rest. */
const SNAP_MS = 500;
/** After a load or a seek the player reports odd positions while it buffers: no drift check for this long. */
const SETTLE_MS = 3000;
export const VOLUME_KEY = "vokko.watch.volume";

export function readVolume(): number {
  try {
    const value = Number(localStorage.getItem(VOLUME_KEY));
    return localStorage.getItem(VOLUME_KEY) !== null && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 60;
  } catch {
    return 60;
  }
}

/** Wires the iframe player to the shared state. `control` sends the player's own PATCHes (the pop-out window has no login and hands them to the main window). */
export function useWatchPlayer(channelId: Snowflake, state: WatchTogetherState, volume: number, control: WatchControl = controlWatch) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [durationMs, setDurationMs] = useState(0);
  const [errorCode, setErrorCode] = useState<number | null>(null);
  const latest = useRef(state);
  latest.current = state;
  const player = useRef({ state: "unstarted" as PlayerState, ms: 0, at: 0, loaded: "", settledAt: 0, endedFor: "", titledFor: "" });

  const send = useCallback((command: EmbedCommand) => sendToEmbed(frame.current?.contentWindow, command), []);

  /** Bring the player to the shared state: load a new video, play / pause, and seek when it is off. */
  const reconcile = useCallback(
    (toleranceMs: number) => {
      const s = latest.current;
      const p = player.current;
      const now = Date.now();
      const expected = expectedPositionMs(s, now);
      if (p.loaded !== s.video_id) {
        p.loaded = s.video_id;
        p.settledAt = now;
        p.state = "unstarted";
        setErrorCode(null);
        setDurationMs(0);
        send({ type: "load", videoId: s.video_id, startSeconds: Math.floor(expected / 1000), autoplay: s.playing });
        return;
      }
      send({ type: s.playing ? "play" : "pause" });
      const at = p.state === "playing" ? p.ms + (now - p.at) : p.ms;
      if (needsSeek(at, expected, toleranceMs)) {
        p.settledAt = now;
        send({ type: "seek", seconds: expected / 1000 });
      }
    },
    [send],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = parseEmbedMessage(event, frame.current?.contentWindow);
      if (!message) return;
      const p = player.current;
      const s = latest.current;
      switch (message.event) {
        case "ready":
          p.loaded = "";
          setReady(true);
          break;
        case "state":
          p.state = message.state;
          if (message.state === "ended" && p.endedFor !== s.video_id) {
            // Everyone's player ends together; the video_id guard makes all but the first skip a no-op on the server.
            p.endedFor = s.video_id;
            void control(channelId, { skip: true, video_id: s.video_id }).catch(() => undefined);
          }
          break;
        case "time": {
          p.ms = message.seconds * 1000;
          p.at = Date.now();
          setDurationMs(message.duration * 1000);
          if (s.playing && p.state === "playing" && p.at - p.settledAt > SETTLE_MS && needsSeek(p.ms, expectedPositionMs(s, p.at), DRIFT_MS)) {
            p.settledAt = p.at;
            send({ type: "seek", seconds: expectedPositionMs(s, p.at) / 1000 });
          }
          break;
        }
        case "meta": {
          // The first client to learn the title tells the others (a little jitter so they do not all PATCH at once).
          const videoId = s.video_id;
          if (s.title || p.titledFor === videoId) break;
          p.titledFor = videoId;
          const title = message.title.trim();
          if (!title) break;
          window.setTimeout(() => {
            const now = latest.current;
            if (now.video_id === videoId && !now.title) void control(channelId, { title }).catch(() => undefined);
          }, Math.random() * 1500);
          break;
        }
        case "error":
          setErrorCode(message.code);
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [channelId, send, control]);

  // Anything the server says changed: the video, play / pause, or a seek (updated_at_ms moves with each).
  useEffect(() => {
    if (ready) reconcile(SNAP_MS);
  }, [ready, reconcile, state.video_id, state.playing, state.position_ms, state.updated_at_ms]);

  useEffect(() => {
    if (ready) send({ type: "volume", volume });
  }, [ready, send, volume]);

  const onLoad = useCallback(() => {
    setReady(false);
    player.current.loaded = "";
    send({ type: "init" });
  }, [send]);

  return { frame, onLoad, durationMs, errorCode };
}

function QueuePanel({ channelId, state, controller, meId }: { channelId: Snowflake; state: WatchTogetherState; controller: boolean; meId: Snowflake | undefined }) {
  const queue = state.queue;
  const quota = queueQuota(state.queue_added_by, meId, controller, WATCH_TOGETHER_QUEUE_PER_USER);
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = parseYouTubeLink(link);
    if (!id) return setError("That doesn't look like a YouTube link.");
    setBusy(true);
    setError(null);
    try {
      await controlWatch(channelId, { queue_add: id });
      setLink("");
    } catch (err) {
      setError(reason(err));
    }
    setBusy(false);
  };
  const remove = (index: number, id: string) => {
    setError(null);
    controlWatch(channelId, { queue_remove: { index, video_id: id } }).catch(e => setError(reason(e)));
  };
  return (
    <aside className="watch-queue" aria-label="Up next">
      <h3 className="watch-queue-title">Up next</h3>
      {queue.length === 0 ? (
        <p className="watch-queue-empty">Nothing queued.</p>
      ) : (
        <ol className="watch-queue-list">
          {queue.map((id, i) => (
            <li key={`${id}-${i}`} className="watch-queue-item" data-video-id={id}>
              <span className="watch-queue-id">{id}</span>
              {(controller || state.queue_added_by[i] === meId) && (
                <button type="button" className="watch-button watch-queue-remove" aria-label={`Remove ${id} from Up next`} onClick={() => remove(i, id)}>
                  <X size={14} />
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      <form className="watch-queue-form" onSubmit={e => void add(e)}>
        <input className="input" aria-label="Add a YouTube link to the queue" placeholder="Paste a YouTube link" value={link} onChange={e => setLink(e.target.value)} />
        <button type="submit" className="btn btn-secondary" disabled={busy || !link.trim() || quota?.full}>
          Add
        </button>
      </form>
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

function ControlButton({ label, tip, active, onClick, children }: { label: string; tip?: string; active?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <Tooltip content={tip ?? label} side="top">
      <button type="button" className={`watch-button${active ? " active" : ""}`} aria-label={label} aria-pressed={active} onClick={onClick}>
        {children}
      </button>
    </Tooltip>
  );
}

/** The tile of the channel's session; nothing once it has ended. */
export function WatchTile(props: { channelId: Snowflake; variant: WatchVariant; onActivate?: () => void }) {
  const state = useVoice(s => s.watch[props.channelId]);
  return state ? <WatchTileBody {...props} state={state} /> : null;
}

function WatchTileBody({ channelId, variant, onActivate, state }: { channelId: Snowflake; variant: WatchVariant; onActivate?: () => void; state: WatchTogetherState }) {
  const starter = useStore(s => s.users[state.started_by]);
  const hostLabel = useHostLabel(state, state.started_by);
  const meId = useMeId();
  const controller = useCanControlMedia(channelId, state.host_id);
  const skip = skipAction(state, meId, controller);
  const [volume, setVolume] = useState(readVolume);
  const [queueOpen, setQueueOpen] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const now = useNow(500);
  // Popped out: the other copy of the player plays; this one keeps its place and its state but not the sound.
  const player = useWatchPlayer(channelId, state, useQuiet(channelId, "watch") ? 0 : volume);

  const small = variant === "strip" || variant === "pip";
  const position = Math.min(expectedPositionMs(state, now), player.durationMs || Infinity);
  const run = (promise: Promise<unknown>) => {
    setFailure(null);
    promise.catch(e => setFailure(reason(e)));
  };
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
    run(controlWatch(channelId, { position_ms: Math.round(drag) }));
    setDrag(null);
  };
  const title = state.title || "YouTube video";

  return (
    <div className={`voice-tile watch ${variant}`} data-watch-tile data-video-id={state.video_id} data-playing={state.playing} role="group" aria-label={`Watch Together: ${title}`}>
      <iframe ref={player.frame} className="watch-player" src={EMBED_URL} title="Watch Together player" tabIndex={-1} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" referrerPolicy="strict-origin-when-cross-origin" onLoad={player.onLoad} />
      {small ? (
        <button type="button" className="watch-cover" aria-label="Focus Watch Together" onClick={onActivate}>
          <Tv size={variant === "pip" ? 20 : 24} aria-hidden="true" />
          <span className="watch-cover-text">Watching YouTube Together</span>
        </button>
      ) : (
        <>
          <div className="watch-head">
            <span className="watch-title">{title}</span>
            {starter && <span className="watch-by">{[`Started by ${displayName(starter)}`, hostLabel].filter(Boolean).join(" · ")}</span>}
            <MediaVotes control={state} />
          </div>
          {(player.errorCode !== null || failure) && (
            <div className="watch-notice" role="alert">
              {player.errorCode !== null ? "This video can't be played here." : failure}
              {player.errorCode !== null && (
                <button type="button" className="btn btn-secondary" aria-pressed={skip.vote ? skip.voted : undefined} onClick={() => run(controlWatch(channelId, { skip: skip.skip, video_id: state.video_id }))}>
                  {skip.label}
                </button>
              )}
            </div>
          )}
          {queueOpen && <QueuePanel channelId={channelId} state={state} controller={controller} meId={meId} />}
          <div className="watch-bar">
            {controller && (
              <input
                className="watch-seek"
                type="range"
                aria-label="Seek"
                min={0}
                max={Math.max(player.durationMs, 1)}
                step={1000}
                value={drag ?? position}
                disabled={player.durationMs === 0}
                onChange={e => setDrag(Number(e.target.value))}
                onPointerUp={commitSeek}
                onKeyUp={commitSeek}
                onBlur={commitSeek}
              />
            )}
            <div className="watch-controls">
              {controller && (
                <ControlButton label={state.playing ? "Pause" : "Play"} onClick={() => run(controlWatch(channelId, { playing: !state.playing }))}>
                  {state.playing ? <Pause size={18} /> : <Play size={18} />}
                </ControlButton>
              )}
              <ControlButton label={skip.label} tip={skip.vote ? `${skip.label}: skips when half the listeners vote` : undefined} active={skip.vote ? skip.voted : undefined} onClick={() => run(controlWatch(channelId, { skip: skip.skip, video_id: state.video_id }))}>
                <SkipForward size={18} />
                {skip.vote && <span className="media-vote-count">{state.skip_votes.length}/{state.skip_needed}</span>}
              </ControlButton>
              <span className="watch-time" aria-label="Position">
                {formatClock(drag ?? position)}
                {player.durationMs > 0 && ` / ${formatClock(player.durationMs)}`}
              </span>
              <span className="watch-spacer" />
              <label className="watch-volume">
                {volume === 0 ? <VolumeX size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
                <input type="range" aria-label="Watch Together volume" min={0} max={100} value={volume} onChange={e => changeVolume(Number(e.target.value))} />
              </label>
              <ControlButton label={`Up next (${state.queue.length})`} active={queueOpen} onClick={() => setQueueOpen(o => !o)}>
                <ListVideo size={18} />
              </ControlButton>
              {onActivate && (
                <ControlButton label={variant === "focused" ? "Back to grid" : "Focus Watch Together"} onClick={onActivate}>
                  {variant === "focused" ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                </ControlButton>
              )}
              {controller && (
                <ControlButton label="Stop Watch Together" onClick={() => run(stopWatch(channelId))}>
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
