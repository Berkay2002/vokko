// The Spotify tile: no picture, only the server's session state (art, title, artists, a seek bar from {position_ms, updated_at_ms}),
// previous / play-pause / skip, shuffle (reorders the queue once), loop (off, queue, track), stop, local volume and Up next with
// remove. Every button is a PATCH that comes back to everyone as SPOTIFY_UPDATE. The sound plays from the call's viewer Room.
// Someone without control (useCanControlMedia) sees no seek, shuffle, previous, play / pause, loop or stop, votes to skip, and
// removes only their own Up next entries.

import { useEffect, useState } from "react";
import { ListMusic, Maximize2, Minimize2, Pause, Play, Plus, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Square, Volume2, VolumeX, X } from "lucide-react";
import { displayName, useStore } from "../api/store";
import { SPOTIFY_QUEUE_PER_USER, type Snowflake, type SpotifyLoop, type SpotifyState } from "../api/types";
import { Tooltip, useContextMenu } from "../ui";
import { MediaVotes, useHostLabel } from "../voice/MediaVotes";
import { useVoice } from "../voice/store";
import { volumeMenuItems } from "../voice/voiceMenus";
import { queueQuota, skipAction, useCanControlMedia, useMeId } from "../voice/useCanControlMedia";
import { formatClock } from "../watch/youtube";
import { reason } from "../stremio/format";
import { botVolumeKey, startViewerAudio, useViewerSlot } from "../stremio/viewerStore";
import { controlSpotify, stopSpotify } from "./api";
import { artistsText, shownPositionMs, statusText } from "./format";
import { openSpotifyPanel } from "./panelStore";
import { Art } from "./SpotifyPanel";
import { SpotifyIcon } from "./SpotifyIcon";
import { setSpotifyVolume, useSpotifyVolume } from "./volume";
import "../stremio/stremio.css";
import "./spotify.css";

export type SpotifyVariant = "solo" | "grid" | "focused" | "strip" | "pip";

/** The id `useVoiceUi.focusedTile` holds for the Spotify tile. */
export const SPOTIFY_TILE_ID = "spotify";

const NEXT_LOOP: Record<SpotifyLoop, SpotifyLoop> = { off: "queue", queue: "track", track: "off" };
const LOOP_LABEL: Record<SpotifyLoop, string> = { off: "Loop: off", queue: "Loop: queue", track: "Loop: track" };

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function ControlButton({ label, tip, active, disabled, onClick, children, primary }: { label: string; tip?: string; active?: boolean; disabled?: boolean; onClick(): void; children: React.ReactNode; primary?: boolean }) {
  return (
    <Tooltip content={tip ?? label} side="top">
      <button type="button" className={`stremio-button${active ? " active" : ""}${primary ? " spotify-main-button" : ""}`} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    </Tooltip>
  );
}

function UpNext({ channelId, state, onFail, controller, meId }: { channelId: Snowflake; state: SpotifyState; onFail(message: string): void; controller: boolean; meId: Snowflake | undefined }) {
  const users = useStore(s => s.users);
  const more = state.queue_len - state.queue.length;
  // shortcut: counts own entries among the first SPOTIFY_EVENT_QUEUE_MAX the event carries, so a long queue can under-count; the server enforces the real quota.
  const quota = queueQuota(state.queue.map(q => q.added_by), meId, controller, SPOTIFY_QUEUE_PER_USER);
  return (
    <aside className="stremio-queue spotify-queue" aria-label="Up next">
      <h3 className="stremio-queue-title">Up next</h3>
      {state.queue.length === 0 ? (
        <p className="stremio-queue-empty">Nothing queued.</p>
      ) : (
        <ol className="stremio-queue-list">
          {state.queue.map(entry => {
            const by = users[entry.added_by];
            return (
              <li key={entry.qid} className="stremio-queue-item" data-qid={entry.qid} data-title={entry.title}>
                <Art art={entry.art} className="small" />
                <span className="stremio-queue-text">
                  <span className="stremio-queue-name">{entry.title}</span>
                  <span className="stremio-queue-sub">{[artistsText(entry.artists), by ? `added by ${displayName(by)}` : null].filter(Boolean).join(" · ")}</span>
                </span>
                {(controller || entry.added_by === meId) && (
                  <button type="button" className="stremio-button" aria-label={`Remove ${entry.title} from Up next`} onClick={() => controlSpotify(channelId, { queue_remove: entry.qid }).catch(e => onFail(reason(e)))}>
                    <X size={14} />
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {more > 0 && <p className="stremio-queue-empty">and {more} more</p>}
      <button type="button" className="btn btn-secondary stremio-queue-add" disabled={quota?.full} onClick={openSpotifyPanel}>
        <Plus size={14} aria-hidden="true" /> Search the catalog
      </button>
      {quota && (
        <p className="media-quota" data-queue-quota={quota.mine}>
          {quota.hint}
        </p>
      )}
    </aside>
  );
}

/** The tile of the channel's session; nothing once it has ended. */
export function SpotifyTile(props: { channelId: Snowflake; variant: SpotifyVariant; onActivate?: () => void }) {
  const state = useVoice(s => s.spotify[props.channelId]);
  return state ? <SpotifyTileBody {...props} state={state} /> : null;
}

function SpotifyTileBody({ channelId, variant, onActivate, state }: { channelId: Snowflake; variant: SpotifyVariant; onActivate?: () => void; state: SpotifyState }) {
  const starter = useStore(s => s.users[state.started_by]);
  const hostLabel = useHostLabel(state, state.started_by);
  const meId = useMeId();
  const controller = useCanControlMedia(channelId, state.host_id);
  const skip = skipAction(state, meId, controller);
  const deaf = useVoice(s => s.selfDeaf);
  const volume = useSpotifyVolume(s => s.volume);
  const viewer = useViewerSlot(channelId);
  const menu = useContextMenu();
  const [queueOpen, setQueueOpen] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const now = useNow(500);

  const small = variant === "strip" || variant === "pip";
  const track = state.track;
  const duration = track?.duration_ms ?? 0;
  const position = shownPositionMs(state, now);
  const status = statusText(state, viewer.room);
  const error = state.status === "error";
  const run = (promise: Promise<unknown>) => {
    setFailure(null);
    promise.catch(e => setFailure(reason(e)));
  };
  const commitSeek = () => {
    if (drag === null) return;
    run(controlSpotify(channelId, { position_ms: Math.round(drag) }));
    setDrag(null);
  };
  const title = track?.title ?? "Spotify";

  return (
    <div
      className={`voice-tile spotify ${variant}`}
      data-spotify-tile
      data-status={state.status}
      data-playing={state.playing}
      data-room={viewer.room}
      data-volume={deaf ? 0 : volume}
      role="group"
      aria-label={`Spotify: ${title}`}
      onContextMenu={e => menu.open(e, volumeMenuItems(botVolumeKey("spotify")))}
    >
      <Art art={track?.art} className="spotify-backdrop" />
      {small ? (
        <button type="button" className="stremio-cover" aria-label="Focus Spotify" onClick={onActivate}>
          <SpotifyIcon size={variant === "pip" ? 20 : 24} />
          <span className="stremio-cover-text">Listening to {title} on Spotify</span>
        </button>
      ) : (
        <>
          <div className="spotify-head">
            <SpotifyIcon size={16} />
            <span className="spotify-head-name">Spotify</span>
            <span className="voice-bot-badge">Bot</span>
            {starter && <span className="spotify-head-by">{[`Started by ${displayName(starter)}`, hostLabel].filter(Boolean).join(" · ")}</span>}
          </div>
          <div className="spotify-now">
            <Art art={track?.art} className="spotify-now-art" />
            <div className="spotify-now-text">
              <span className="spotify-now-title">{title}</span>
              {track && <span className="spotify-now-artists">{artistsText(track.artists)}</span>}
              {track?.album && <span className="spotify-now-album">{track.album}</span>}
              {status && (
                <span className={`spotify-status${error ? " error" : ""}`} role="status">
                  {status}
                </span>
              )}
              {state.notice && (
                <span className="spotify-status" role="status">
                  {state.notice}
                </span>
              )}
              <MediaVotes control={state} />
            </div>
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
          {queueOpen && <UpNext channelId={channelId} state={state} onFail={setFailure} controller={controller} meId={meId} />}
          <div className="stremio-bar spotify-bar">
            <div className="spotify-seek-row">
              <span className="stremio-time" aria-label="Position">
                {formatClock(drag ?? position)}
              </span>
              {controller ? (
                <input
                  className="stremio-seek spotify-seek"
                  type="range"
                  aria-label="Seek"
                  min={0}
                  max={Math.max(duration, 1)}
                  step={1000}
                  value={drag ?? position}
                  disabled={!track || error}
                  onChange={e => setDrag(Number(e.target.value))}
                  onPointerUp={commitSeek}
                  onKeyUp={commitSeek}
                  onBlur={commitSeek}
                />
              ) : (
                <span className="stremio-spacer" />
              )}
              <span className="stremio-time" aria-label="Duration">
                {formatClock(duration)}
              </span>
            </div>
            <div className="stremio-controls spotify-controls">
              <label className="stremio-volume">
                {volume === 0 || deaf ? <VolumeX size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
                <input type="range" aria-label="Spotify volume" min={0} max={100} value={volume} onChange={e => setSpotifyVolume(Number(e.target.value))} />
              </label>
              <span className="stremio-spacer" />
              {controller && (
                <>
                  <ControlButton label="Shuffle the queue" disabled={error || state.queue_len < 2} onClick={() => run(controlSpotify(channelId, { shuffle: true }))}>
                    <Shuffle size={18} />
                  </ControlButton>
                  <ControlButton label="Previous" disabled={error} onClick={() => run(controlSpotify(channelId, { previous: true }))}>
                    <SkipBack size={18} />
                  </ControlButton>
                  <ControlButton primary label={state.playing ? "Pause" : "Play"} disabled={error || !track} onClick={() => run(controlSpotify(channelId, { playing: !state.playing }))}>
                    {state.playing ? <Pause size={18} /> : <Play size={18} />}
                  </ControlButton>
                </>
              )}
              <ControlButton label={skip.label} tip={skip.vote ? `${skip.label}: skips when half the listeners vote` : undefined} active={skip.vote ? skip.voted : undefined} disabled={error || !track} onClick={() => run(controlSpotify(channelId, { skip: skip.skip, item_seq: state.item_seq }))}>
                <SkipForward size={18} />
                {skip.vote && <span className="media-vote-count">{state.skip_votes.length}/{state.skip_needed}</span>}
              </ControlButton>
              {controller && (
                <ControlButton label={LOOP_LABEL[state.loop]} active={state.loop !== "off"} disabled={error} onClick={() => run(controlSpotify(channelId, { loop: NEXT_LOOP[state.loop] }))}>
                  {state.loop === "track" ? <Repeat1 size={18} /> : <Repeat size={18} />}
                </ControlButton>
              )}
              <span className="stremio-spacer" />
              <ControlButton label={`Up next (${state.queue_len})`} active={queueOpen} onClick={() => setQueueOpen(o => !o)}>
                <ListMusic size={18} />
              </ControlButton>
              {onActivate && (
                <ControlButton label={variant === "focused" ? "Back to grid" : "Focus Spotify"} onClick={onActivate}>
                  {variant === "focused" ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                </ControlButton>
              )}
              {controller && (
                <ControlButton label="Stop Spotify" onClick={() => run(stopSpotify(channelId))}>
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
