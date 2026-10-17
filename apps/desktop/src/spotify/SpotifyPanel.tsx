// The Spotify side panel of a call (docs/design/spotify-bot.md section 7): search the public catalog (Tracks, Albums, Playlists,
// Artists), album, playlist and artist pages, and Play now / Play next / Add to queue on every track and page. The server proxies
// the catalog; nothing here knows the house account, and there is no library, history or recommendation anywhere.

import { useEffect, useReducer, useState } from "react";
import { AlertTriangle, ArrowLeft, ListEnd, ListStart, Music, Play, Search, X } from "lucide-react";
import type { Snowflake, SpotifyAlbumSummary, SpotifyArtistSummary, SpotifyPlaylistSummary, SpotifySearchType, SpotifyTrack } from "../api/types";
import { useVoice } from "../voice/store";
import { formatClock } from "../watch/youtube";
import { reason } from "../stremio/format";
import { controlSpotify, getAlbum, getArtist, getPlaylist, playSpotify, search } from "./api";
import { artistsText, artUrl, conflictOf } from "./format";
import { currentView, initialPanel, panelReducer, type PageKind, type PanelAction } from "./panelState";
import { useSpotifyPanel } from "./panelStore";
import { SpotifyIcon } from "./SpotifyIcon";
import "../stremio/stremio.css";
import "./spotify.css";

const SEARCH_DELAY_MS = 300;
const TABS: { tab: SpotifySearchType; label: string }[] = [
  { tab: "track", label: "Tracks" },
  { tab: "album", label: "Albums" },
  { tab: "playlist", label: "Playlists" },
  { tab: "artist", label: "Artists" },
];

type Dispatch = (action: PanelAction) => void;
/** What a play or queue button reports back to the panel: a short note, a conflict, or an error line. */
type Report = (result: { note?: string; conflict?: string; problem?: string }) => void;

function useAsync<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean } {
  const [result, setResult] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  useEffect(() => {
    let current = true;
    setResult({ data: null, error: null, loading: true });
    load().then(
      data => current && setResult({ data, error: null, loading: false }),
      e => current && setResult({ data: null, error: reason(e), loading: false }),
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return result;
}

export function Art({ art, className, round }: { art: string | undefined; className?: string; round?: boolean }) {
  const src = artUrl(art);
  const [broken, setBroken] = useState(false);
  return (
    <span className={`spotify-art${round ? " round" : ""}${className ? ` ${className}` : ""}`}>
      {src && !broken ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : <Music size={16} aria-hidden="true" />}
    </span>
  );
}

/** Play now / Play next / Add to queue for one URI (a track, album or playlist). Only Play while nothing plays here. */
function PlayActions({ channelId, uri, name, report, compact }: { channelId: Snowflake; uri: string; name: string; report: Report; compact?: boolean }) {
  const playing = useVoice(s => !!s.spotify[channelId]);
  const [busy, setBusy] = useState(false);
  const run = async (kind: "play" | "next" | "queue") => {
    setBusy(true);
    try {
      const reply = kind === "play" ? await playSpotify(channelId, uri) : await controlSpotify(channelId, { queue_add: { uri, next: kind === "next" } });
      const left = reply.left_out ? ` ${reply.left_out} tracks didn't fit in the queue.` : "";
      report({ note: (kind === "play" ? `Playing ${name}.` : kind === "next" ? `${name} plays next.` : `Added ${name} to the queue.`) + left });
    } catch (e) {
      const conflict = conflictOf(e);
      report(conflict ? { conflict } : { problem: reason(e) });
    }
    setBusy(false);
  };
  return (
    <span className={`spotify-actions${compact ? " compact" : ""}`}>
      <button type="button" className="btn btn-primary spotify-play" disabled={busy} onClick={() => void run("play")}>
        <Play size={14} aria-hidden="true" /> {playing ? "Play now" : "Play"}
      </button>
      {playing && (
        <>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void run("next")}>
            <ListStart size={14} aria-hidden="true" /> Play next
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void run("queue")}>
            <ListEnd size={14} aria-hidden="true" /> Add to queue
          </button>
        </>
      )}
    </span>
  );
}

function TrackList({ channelId, tracks, numbered, report }: { channelId: Snowflake; tracks: SpotifyTrack[]; numbered?: boolean; report: Report }) {
  const [open, setOpen] = useState<string | null>(null);
  if (tracks.length === 0) return <p className="stremio-muted">Nothing found.</p>;
  return (
    <ul className="spotify-tracks" aria-label="Tracks">
      {tracks.map((t, i) => (
        <li key={`${t.uri}-${i}`} className={`spotify-track${open === t.uri ? " open" : ""}`} data-uri={t.uri}>
          <button type="button" className="spotify-track-main" aria-expanded={open === t.uri} onClick={() => setOpen(o => (o === t.uri ? null : t.uri))}>
            {numbered ? <span className="spotify-track-number">{i + 1}</span> : <Art art={t.art} className="small" />}
            <span className="spotify-track-text">
              <span className="spotify-track-title">
                {t.title}
                {t.explicit && <span className="spotify-explicit" aria-label="Explicit">E</span>}
              </span>
              <span className="spotify-track-sub">{artistsText(t.artists)}</span>
            </span>
            <span className="spotify-track-time">{formatClock(t.duration_ms)}</span>
          </button>
          {open === t.uri && <PlayActions channelId={channelId} uri={t.uri} name={t.title} report={report} compact />}
        </li>
      ))}
    </ul>
  );
}

function Cards<T extends { id: string; name: string; art?: string }>({ items, kind, sub, dispatch }: { items: T[]; kind: PageKind; sub(item: T): string; dispatch: Dispatch }) {
  if (items.length === 0) return <p className="stremio-muted">Nothing found.</p>;
  return (
    <div className="spotify-cards">
      {items.map(item => (
        <button key={item.id} type="button" className="spotify-card" data-id={item.id} onClick={() => dispatch({ type: "open", kind, id: item.id, title: item.name })}>
          <Art art={item.art} className="cover" round={kind === "artist"} />
          <span className="spotify-card-name">{item.name}</span>
          <span className="spotify-card-sub">{sub(item)}</span>
        </button>
      ))}
    </div>
  );
}

const albumSub = (a: SpotifyAlbumSummary) => [a.year, artistsText(a.artists)].filter(Boolean).join(" · ");
const playlistSub = (p: SpotifyPlaylistSummary) => `By ${p.owner_name}`;
const artistSub = (_: SpotifyArtistSummary) => "Artist";

function SearchView({ channelId, query, tab, dispatch, report }: { channelId: Snowflake; query: string; tab: SpotifySearchType; dispatch: Dispatch; report: Report }) {
  const [typed, setTyped] = useState(query);
  useEffect(() => {
    if (typed.trim() === query) return;
    const id = setTimeout(() => dispatch({ type: "query", query: typed.trim() }), SEARCH_DELAY_MS);
    return () => clearTimeout(id);
  }, [typed, query, dispatch]);
  const results = useAsync(() => (query ? search(query, tab) : Promise.resolve(null)), [query, tab]);
  return (
    <>
      <label className="stremio-search">
        <Search size={16} aria-hidden="true" />
        <input className="input" type="search" aria-label="Search the public catalog" placeholder="Search the public catalog, or paste a Spotify link" value={typed} onChange={e => setTyped(e.target.value)} />
      </label>
      <div className="spotify-tabs" role="tablist" aria-label="Result type">
        {TABS.map(t => (
          <button key={t.tab} type="button" role="tab" aria-selected={t.tab === tab} className={`spotify-tab${t.tab === tab ? " selected" : ""}`} onClick={() => dispatch({ type: "tab", tab: t.tab })}>
            {t.label}
          </button>
        ))}
      </div>
      {!query && <p className="stremio-muted">Search for a track, album, playlist or artist. Everyone in the call hears what plays.</p>}
      {query && results.loading && <p className="stremio-muted">Searching…</p>}
      {results.error && (
        <p className="field-error" role="alert">
          {results.error}
        </p>
      )}
      {results.data && (
        <section className="spotify-results" aria-label="Search results">
          {tab === "track" && <TrackList channelId={channelId} tracks={results.data.tracks} report={report} />}
          {tab === "album" && <Cards items={results.data.albums} kind="album" sub={albumSub} dispatch={dispatch} />}
          {tab === "playlist" && <Cards items={results.data.playlists} kind="playlist" sub={playlistSub} dispatch={dispatch} />}
          {tab === "artist" && <Cards items={results.data.artists} kind="artist" sub={artistSub} dispatch={dispatch} />}
        </section>
      )}
    </>
  );
}

function PageHead({ art, title, sub, round, children }: { art?: string; title: string; sub: string; round?: boolean; children?: React.ReactNode }) {
  return (
    <div className="spotify-page-head">
      <Art art={art} className="hero" round={round} />
      <div className="spotify-page-text">
        <h3 className="spotify-page-title">{title}</h3>
        <p className="stremio-muted">{sub}</p>
        {children}
      </div>
    </div>
  );
}

function Page({ channelId, kind, id, dispatch, report }: { channelId: Snowflake; kind: PageKind; id: string; dispatch: Dispatch; report: Report }) {
  const page = useAsync<
    | { kind: "album"; data: Awaited<ReturnType<typeof getAlbum>> }
    | { kind: "playlist"; data: Awaited<ReturnType<typeof getPlaylist>> }
    | { kind: "artist"; data: Awaited<ReturnType<typeof getArtist>> }
  >(async () => (kind === "album" ? { kind, data: await getAlbum(id) } : kind === "playlist" ? { kind, data: await getPlaylist(id) } : { kind, data: await getArtist(id) }), [kind, id]);
  if (page.loading) return <p className="stremio-muted">Loading…</p>;
  if (page.error || !page.data)
    return (
      <p className="field-error" role="alert">
        {page.error}
      </p>
    );
  const p = page.data;
  if (p.kind === "artist") {
    return (
      <>
        <PageHead art={p.data.art} title={p.data.name} sub="Artist" round />
        <h3 className="stremio-row-title">Top tracks</h3>
        <TrackList channelId={channelId} tracks={p.data.top_tracks} report={report} />
        <h3 className="stremio-row-title">Albums</h3>
        <Cards items={p.data.albums} kind="album" sub={albumSub} dispatch={dispatch} />
      </>
    );
  }
  const uri = `spotify:${p.kind}:${p.data.id}`;
  const sub =
    p.kind === "album"
      ? [artistsText(p.data.artists), p.data.year, `${p.data.tracks.length} tracks`].filter(Boolean).join(" · ")
      : [`By ${p.data.owner_name}`, `${p.data.total} tracks`].join(" · ");
  return (
    <>
      <PageHead art={p.data.art} title={p.data.name} sub={sub}>
        <PlayActions channelId={channelId} uri={uri} name={p.data.name} report={report} />
      </PageHead>
      <TrackList channelId={channelId} tracks={p.data.tracks} numbered={p.kind === "album"} report={report} />
    </>
  );
}

export function SpotifyPanel({ channelId }: { channelId: Snowflake }) {
  const [state, dispatch] = useReducer(panelReducer, initialPanel);
  const [result, setResult] = useState<{ note?: string; conflict?: string; problem?: string }>({});
  const view = currentView(state);
  const close = () => useSpotifyPanel.getState().setOpen(false);

  return (
    <aside className="stremio-panel spotify-panel" aria-label="Spotify">
      <header className="stremio-panel-header">
        {view.name !== "search" ? (
          <button type="button" className="stremio-icon-button" aria-label="Back" onClick={() => dispatch({ type: "back" })}>
            <ArrowLeft size={18} />
          </button>
        ) : (
          <SpotifyIcon size={20} />
        )}
        <h2 className="stremio-panel-title">
          {view.name === "search" ? "Spotify" : view.title} {view.name === "search" && <span className="voice-bot-badge">Bot</span>}
        </h2>
        <button type="button" className="stremio-icon-button" aria-label="Close Spotify" onClick={close}>
          <X size={18} />
        </button>
      </header>
      <div className="stremio-panel-body">
        {result.conflict && (
          <div className="spotify-conflict" role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            <div>
              <p>{result.conflict}</p>
              <button type="button" className="stremio-linkish" onClick={() => setResult({})}>
                Dismiss
              </button>
            </div>
          </div>
        )}
        {result.problem && (
          <p className="field-error" role="alert">
            {result.problem}
          </p>
        )}
        {result.note && (
          <p className="stremio-note" role="status">
            {result.note}
          </p>
        )}
        {view.name === "search" ? (
          <SearchView channelId={channelId} query={state.query} tab={state.tab} dispatch={dispatch} report={setResult} />
        ) : (
          <Page key={`${view.kind}:${view.id}`} channelId={channelId} kind={view.kind} id={view.id} dispatch={dispatch} report={setResult} />
        )}
      </div>
    </aside>
  );
}
