// The Stremio side panel of a call (docs/design/stremio-bot.md section 7): link your Stremio account, search and browse Cinemeta,
// a title page with a season / episode picker, and a ranked stream list with Play in call / Add to Up next. The server does all the
// talking to Stremio; this panel only ever sees titles, posters, labels and opaque stream ids.

import { createContext, useContext, useEffect, useReducer, useState } from "react";
import { ArrowLeft, Check, ExternalLink, Info, Link2, Play, Search, X } from "lucide-react";
import { QrCode } from "../account/QrCode";
import { ApiRequestError } from "../api/rest";
import type { Snowflake, StremioMeta, StremioSearchItem, StremioStream, StremioStreams, StremioType } from "../api/types";
import { useVoice } from "../voice/store";
import { useVoiceUi } from "../voice/uiStore";
import { catalog, controlStremio, getAccount, getMeta, getStreams, loginWithEmail, pollLink, searchTitles, startLink, startStremio, unlinkAccount } from "./api";
import { formatSize, isHeavy, reason, safeImage, unsupportedText } from "./format";
import { bestStream, currentView, initialPanel, panelReducer, seasonsOf, type PanelAction, type PanelState } from "./panelState";
import { useStremioPanel } from "./panelStore";
import { StremioIcon } from "./StremioIcon";
import "./stremio.css";

/** The id `useVoiceUi.focusedTile` holds for the Stremio tile (same idea as the Watch Together tile). */
export const STREMIO_TILE_ID = "stremio";

const POLL_MS = 3000;
const LINK_LIFETIME_MS = 5 * 60_000;
const SEARCH_DELAY_MS = 300;


type Dispatch = (action: PanelAction) => void;

function Problem({ text }: { text: string | null }) {
  return text ? (
    <p className="field-error" role="alert">
      {text}
    </p>
  ) : null;
}

// ---- linking ----

function EmailForm({ dispatch, problem }: { dispatch: Dispatch; problem: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await loginWithEmail(email.trim(), password);
      dispatch({ type: "linked" });
    } catch (err) {
      dispatch({ type: "linkFailed", message: reason(err) });
      setBusy(false);
    }
  };
  return (
    <form className="stremio-card" onSubmit={e => void submit(e)}>
      <h3 className="stremio-card-title">Sign in to Stremio</h3>
      <p className="stremio-muted">Your password is sent to Stremio once to get a sign-in key. Vokko never stores it.</p>
      <label className="field-label" htmlFor="stremio-email">
        Email
      </label>
      <input id="stremio-email" className="input" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} />
      <label className="field-label" htmlFor="stremio-password">
        Password
      </label>
      <input id="stremio-password" className="input" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
      <Problem text={problem} />
      <button type="submit" className="btn btn-primary" disabled={busy || !email.trim() || !password}>
        Sign in
      </button>
      <button type="button" className="stremio-linkish" onClick={() => dispatch({ type: "showLink" })}>
        Use a link code instead
      </button>
    </form>
  );
}

function LinkCard({ state, dispatch }: { state: PanelState; dispatch: Dispatch }) {
  const [busy, setBusy] = useState(false);
  const begin = async () => {
    setBusy(true);
    try {
      dispatch({ type: "linkStarted", link: await startLink() });
    } catch (e) {
      dispatch({ type: "linkFailed", message: reason(e) });
    }
    setBusy(false);
  };

  // While a code is open, ask whether it was approved every few seconds, for as long as it lives.
  const linking = state.account === "linking";
  useEffect(() => {
    if (!linking) return;
    const started = Date.now();
    let stopped = false;
    const timer = setInterval(() => {
      if (Date.now() - started > LINK_LIFETIME_MS) {
        dispatch({ type: "linkFailed", message: "The link expired. Start again." });
        return;
      }
      pollLink().then(
        r => {
          if (r.linked && !stopped) dispatch({ type: "linked" });
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [linking, dispatch]);

  if (state.account === "email") return <EmailForm dispatch={dispatch} problem={state.problem} />;
  if (state.account === "linking" && state.link) {
    return (
      <div className="stremio-card">
        <h3 className="stremio-card-title">Approve this link in Stremio</h3>
        <a className="btn btn-primary stremio-open" href={state.link.link} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={16} aria-hidden="true" /> Open Stremio link
        </a>
        <p className="stremio-muted">Or scan the code with your phone, or enter it at link.stremio.com.</p>
        <div className="stremio-qr">
          <QrCode data={state.link.link} label="QR code for the Stremio link" />
        </div>
        <p className="stremio-code" aria-label="Link code">
          {state.link.code}
        </p>
        <p className="stremio-muted" role="status">
          Waiting for you to approve it…
        </p>
        <Problem text={state.problem} />
        <button type="button" className="stremio-linkish" onClick={() => dispatch({ type: "showEmail" })}>
          Sign in with email instead
        </button>
      </div>
    );
  }
  return (
    <div className="stremio-card">
      <h3 className="stremio-card-title">Link your Stremio account</h3>
      <p className="stremio-muted">Streams come from the addons installed in your own Stremio account, so you pick what plays. Only you can start things from your account.</p>
      <Problem text={state.problem} />
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void begin()}>
        <Link2 size={16} aria-hidden="true" /> Link with Stremio
      </button>
      <button type="button" className="stremio-linkish" onClick={() => dispatch({ type: "showEmail" })}>
        Sign in with email instead
      </button>
    </div>
  );
}

// ---- browsing ----

/** Called when the server says the link is gone (403 50013: Stremio no longer accepts the key and it was deleted), so the panel asks for a new one. */
const LinkLost = createContext<() => void>(() => undefined);

function useAsync<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean } {
  const linkLost = useContext(LinkLost);
  const [result, setResult] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  useEffect(() => {
    let current = true;
    setResult({ data: null, error: null, loading: true });
    load().then(
      data => current && setResult({ data, error: null, loading: false }),
      e => {
        if (!current) return;
        if (e instanceof ApiRequestError && e.status === 403 && e.code === 50013) linkLost();
        setResult({ data: null, error: reason(e), loading: false });
      },
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return result;
}

function PosterCard({ item, onOpen }: { item: StremioSearchItem; onOpen(item: StremioSearchItem): void }) {
  const poster = safeImage(item.poster);
  return (
    <button type="button" className="stremio-poster-card" onClick={() => onOpen(item)} data-title-id={item.id}>
      <span className="stremio-poster-frame">{poster ? <img src={poster} alt="" loading="lazy" /> : <StremioIcon size={28} />}</span>
      <span className="stremio-poster-name">{item.name}</span>
      {item.year && <span className="stremio-poster-year">{item.year}</span>}
    </button>
  );
}

function Row({ title, items, onOpen }: { title: string; items: StremioSearchItem[]; onOpen(item: StremioSearchItem): void }) {
  return (
    <section className="stremio-row" aria-label={title}>
      <h3 className="stremio-row-title">{title}</h3>
      {items.length === 0 ? (
        <p className="stremio-muted">Nothing found.</p>
      ) : (
        <div className="stremio-row-items">
          {items.map(item => (
            <PosterCard key={item.id} item={item} onOpen={onOpen} />
          ))}
        </div>
      )}
    </section>
  );
}

const TYPE_TITLES: Record<StremioType, string> = { movie: "Movies", series: "Series" };

function Home({ query, dispatch }: { query: string; dispatch: Dispatch }) {
  const [typed, setTyped] = useState(query);
  useEffect(() => {
    if (typed.trim() === query) return;
    const id = setTimeout(() => dispatch({ type: "query", query: typed.trim() }), SEARCH_DELAY_MS);
    return () => clearTimeout(id);
  }, [typed, query, dispatch]);
  const rows = useAsync(async () => {
    const types: StremioType[] = ["movie", "series"];
    const lists = await Promise.all(types.map(t => (query ? searchTitles(t, query) : catalog(t))));
    return types.map((type, i) => ({ type, items: lists[i] ?? [] }));
  }, [query]);
  const open = (item: StremioSearchItem) => dispatch({ type: "openTitle", item });
  return (
    <>
      <label className="stremio-search">
        <Search size={16} aria-hidden="true" />
        <input className="input" type="search" aria-label="Search movies and series" placeholder="Search movies and series" value={typed} onChange={e => setTyped(e.target.value)} />
      </label>
      {rows.loading && <p className="stremio-muted">Loading…</p>}
      <Problem text={rows.error} />
      {rows.data?.map(row => <Row key={row.type} title={query ? TYPE_TITLES[row.type] : `Popular ${TYPE_TITLES[row.type].toLowerCase()}`} items={row.items} onOpen={open} />)}
    </>
  );
}

// ---- title page and streams ----

function StreamList({ channelId, type, videoId, label }: { channelId: Snowflake; type: StremioType; videoId: string; label: string }) {
  const playing = useVoice(s => !!s.stremio[channelId]);
  const listed = useAsync<StremioStreams>(() => getStreams(type, videoId), [type, videoId]);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const streams = listed.data?.streams ?? [];
  const selected = streams.find(s => s.sid === picked && s.playable) ?? bestStream(streams);
  const groups = [...new Set(streams.map(s => s.addon))].map(addon => ({ addon, rows: streams.filter(s => s.addon === addon) }));

  const act = async (kind: "play" | "queue") => {
    if (!selected || busy) return;
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      if (kind === "play") {
        await startStremio(channelId, selected.sid);
        useVoiceUi.getState().setFocusedTile(STREMIO_TILE_ID);
        useStremioPanel.getState().setOpen(false);
        return;
      }
      await controlStremio(channelId, { queue_add: selected.sid });
      setNote("Added to Up next.");
    } catch (e) {
      setProblem(reason(e));
    }
    setBusy(false);
  };

  return (
    <section className="stremio-streams" aria-label={`Streams for ${label}`}>
      <h3 className="stremio-row-title">Streams</h3>
      {listed.loading && <p className="stremio-muted">Looking for streams…</p>}
      <Problem text={listed.error} />
      {listed.data && streams.length === 0 && <p className="stremio-muted">No streams found in your addons.</p>}
      {groups.map(group => (
        <div key={group.addon} className="stremio-group" role="radiogroup" aria-label={group.addon}>
          <h4 className="stremio-group-title">{group.addon}</h4>
          {group.rows.map(stream => (
            <StreamRow key={stream.sid} stream={stream} selected={selected?.sid === stream.sid} onPick={() => setPicked(stream.sid)} />
          ))}
        </div>
      ))}
      {listed.data && listed.data.addon_errors.length > 0 && <p className="stremio-muted stremio-quiet stremio-unreached"><Info size={14} aria-hidden="true" /> Couldn't reach: {listed.data.addon_errors.join(", ")}</p>}
      <Problem text={problem} />
      {note && (
        <p className="stremio-note" role="status">
          {note}
        </p>
      )}
      {selected && (
        <div className="stremio-actions">
          {playing ? (
            <>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act("queue")}>
                Add to Up next
              </button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void act("play")}>
                Play now instead
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary stremio-play" disabled={busy} onClick={() => void act("play")}>
              <Play size={16} aria-hidden="true" /> Play in call
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function StreamRow({ stream, selected, onPick }: { stream: StremioStream; selected: boolean; onPick(): void }) {
  const heavy = isHeavy(stream);
  const disabled = !stream.playable;
  return (
    <button type="button" role="radio" aria-checked={selected} aria-disabled={disabled || undefined} className={`stremio-stream${selected ? " selected" : ""}${disabled ? " disabled" : ""}`} onClick={disabled ? undefined : onPick} data-sid={stream.sid}>
      <span className="stremio-stream-head">
        <span className="stremio-chip quality">{stream.label}</span>
        {stream.size_bytes !== undefined && <span className="stremio-chip">{formatSize(stream.size_bytes)}</span>}
        {stream.flags.map(flag => (
          <span key={flag} className="stremio-chip heavy">
            {flag.toUpperCase()}
          </span>
        ))}
        {heavy && <span className="stremio-chip heavy">Heavy</span>}
        {selected && <Check className="stremio-stream-check" size={16} aria-hidden="true" />}
      </span>
      <span className="stremio-stream-details">{disabled ? unsupportedText(stream) : stream.details.split("\n")[0]}</span>
    </button>
  );
}

function Backdrop({ meta }: { meta: StremioMeta }) {
  const background = safeImage(meta.background);
  const poster = safeImage(meta.poster);
  return (
    <div className="stremio-hero" style={background ? { backgroundImage: `url(${background})` } : undefined}>
      <div className="stremio-hero-body">
        {poster && <img className="stremio-hero-poster" src={poster} alt="" />}
        <div>
          <h3 className="stremio-hero-title">{meta.name}</h3>
          <p className="stremio-muted">{[meta.year, meta.runtime].filter(Boolean).join(" · ")}</p>
        </div>
      </div>
    </div>
  );
}

function TitlePage({ channelId, item, dispatch }: { channelId: Snowflake; item: StremioSearchItem; dispatch: Dispatch }) {
  const meta = useAsync(() => getMeta(item.type, item.id), [item.type, item.id]);
  const [season, setSeason] = useState<number | null>(null);
  const videos = meta.data?.videos ?? [];
  const seasons = seasonsOf(videos);
  const shown = season ?? seasons[0] ?? 1;
  return (
    <>
      {meta.loading && <p className="stremio-muted">Loading…</p>}
      <Problem text={meta.error} />
      {meta.data && (
        <>
          <Backdrop meta={meta.data} />
          {meta.data.description && <p className="stremio-description">{meta.data.description}</p>}
          {item.type === "movie" ? (
            <StreamList channelId={channelId} type="movie" videoId={item.id} label={item.name} />
          ) : (
            <section className="stremio-episodes" aria-label="Episodes">
              <div className="stremio-seasons" role="tablist" aria-label="Seasons">
                {seasons.map(s => (
                  <button key={s} type="button" role="tab" aria-selected={s === shown} className={`stremio-season${s === shown ? " selected" : ""}`} onClick={() => setSeason(s)}>
                    {s === 0 ? "Specials" : `Season ${s}`}
                  </button>
                ))}
              </div>
              <ul className="stremio-episode-list">
                {videos
                  .filter(v => v.season === shown)
                  .sort((a, b) => a.episode - b.episode)
                  .map(v => {
                    const thumb = safeImage(v.thumbnail);
                    return (
                      <li key={v.id}>
                        <button type="button" className="stremio-episode" data-video-id={v.id} onClick={() => dispatch({ type: "openStreams", videoId: v.id, label: `S${v.season}E${v.episode}${v.name ? ` ${v.name}` : ""}` })}>
                          <span className="stremio-episode-thumb">{thumb && <img src={thumb} alt="" loading="lazy" />}</span>
                          <span className="stremio-episode-text">
                            <span className="stremio-episode-name">
                              {v.episode}. {v.name ?? `Episode ${v.episode}`}
                            </span>
                            {v.released && <span className="stremio-muted">{v.released.slice(0, 10)}</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}

export function StremioPanel({ channelId }: { channelId: Snowflake }) {
  const [state, dispatch] = useReducer(panelReducer, initialPanel);
  const view = currentView(state);
  const close = () => useStremioPanel.getState().setOpen(false);

  useEffect(() => {
    let current = true;
    getAccount().then(
      a => current && dispatch({ type: "account", linked: a.linked }),
      () => current && dispatch({ type: "unavailable" }),
    );
    return () => {
      current = false;
    };
  }, []);

  return (
    <aside className="stremio-panel" aria-label="Stremio">
      <header className="stremio-panel-header">
        {state.account === "linked" && view.name !== "home" ? (
          <button type="button" className="stremio-icon-button" aria-label="Back" onClick={() => dispatch({ type: "back" })}>
            <ArrowLeft size={18} />
          </button>
        ) : (
          <StremioIcon size={20} />
        )}
        <h2 className="stremio-panel-title">{view.name === "home" || state.account !== "linked" ? "Stremio" : view.item.name}</h2>
        {state.account === "linked" && (
          <button
            type="button"
            className="stremio-linkish"
            onClick={() => {
              void unlinkAccount().then(() => dispatch({ type: "unlinked" }), () => undefined);
            }}
          >
            Unlink
          </button>
        )}
        <button type="button" className="stremio-icon-button" aria-label="Close Stremio" onClick={close}>
          <X size={18} />
        </button>
      </header>
      <div className="stremio-panel-body">
        <LinkLost.Provider value={() => dispatch({ type: "unlinked" })}>
          {state.account === "loading" && <p className="stremio-muted">Loading…</p>}
          {state.account === "unavailable" && <p className="stremio-muted">Stremio isn't set up on this server.</p>}
          {(state.account === "unlinked" || state.account === "linking" || state.account === "email") && <LinkCard state={state} dispatch={dispatch} />}
          {state.account === "linked" && view.name === "home" && <Home query={state.query} dispatch={dispatch} />}
          {state.account === "linked" && view.name === "title" && <TitlePage channelId={channelId} item={view.item} dispatch={dispatch} />}
          {state.account === "linked" && view.name === "streams" && <StreamList channelId={channelId} type={view.item.type} videoId={view.videoId} label={view.label} />}
        </LinkLost.Provider>
      </div>
    </aside>
  );
}
