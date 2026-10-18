import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Clock, Search, Star, TrendingUp, X } from 'lucide-react';
import type { Gif, GifCategories, GifCategory, GifPage, GifProvider } from '../api/types';
import { isFavorite } from './lists';
import { safeMediaUrl } from './helpers';
import { AnimatedImage, request, resolveUrl, ApiRequestError } from './shell';
import { loadFavorites, toggleFavorite, useMedia } from './store';

type Source = { kind: 'search'; q: string } | { kind: 'trending' };
type View = { kind: 'home' } | { kind: 'favorites' } | { kind: 'recent' } | { kind: 'trending' } | { kind: 'category'; name: string };

interface Listing {
  gifs: Gif[];
  next: string | null;
  loading: boolean;
  error: string | null;
}
const EMPTY: Listing = { gifs: [], next: null, loading: false, error: null };
const PAGE = 24;
const DEBOUNCE_MS = 250;

const sourceKey = (s: Source | null): string => (s ? (s.kind === 'trending' ? 'trending' : `search:${s.q}`) : '');

function pathOf(source: Source, pos: string | null): string {
  const q = new URLSearchParams({ limit: String(PAGE) });
  if (pos) q.set('pos', pos);
  if (source.kind === 'search') q.set('q', source.q);
  return `/gifs/${source.kind === 'search' ? 'search' : 'trending'}?${q}`;
}

/** Fetches a GIF listing page by page; a newer source supersedes an in-flight older one. Reports the provider the server answered with. */
function useListing(source: Source | null, onProvider: (p: GifProvider) => void) {
  const [listing, setListing] = useState<Listing>(EMPTY);
  const live = useRef('');
  const key = sourceKey(source);

  const load = useCallback(async (src: Source, pos: string | null, base: Gif[]) => {
    const mine = sourceKey(src);
    live.current = mine;
    setListing({ gifs: base, next: null, loading: true, error: null });
    try {
      const page = await request<GifPage>('GET', pathOf(src, pos));
      if (live.current !== mine) return;
      onProvider(page.provider);
      const seen = new Set(base.map(g => g.id));
      setListing({ gifs: [...base, ...page.results.filter(g => !seen.has(g.id))], next: page.next, loading: false, error: null });
    } catch (e) {
      if (live.current !== mine) return;
      setListing({ gifs: base, next: null, loading: false, error: e instanceof ApiRequestError && e.status === 502 ? 'The GIF provider did not answer.' : 'Could not load GIFs.' });
    }
  }, [onProvider]);

  useEffect(() => {
    if (!source) { live.current = ''; setListing(EMPTY); return; }
    void load(source, null, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load]);

  return {
    listing,
    more: () => { if (source && listing.next && !listing.loading) void load(source, listing.next, listing.gifs); },
    retry: () => { if (source) void load(source, null, []); },
  };
}

/** Two-column masonry: each GIF goes to the shorter column, so the grid stays balanced whatever the aspect ratios. */
function columns(gifs: Gif[]): Gif[][] {
  const cols: Gif[][] = [[], []];
  const heights = [0, 0];
  for (const g of gifs) {
    const i = heights[0]! <= heights[1]! ? 0 : 1;
    cols[i]!.push(g);
    heights[i]! += g.width > 0 && g.height > 0 ? g.height / g.width : 0.75;
  }
  return cols;
}

function GifGrid({ gifs, favorites, onPick, pickLabel }: { gifs: Gif[]; favorites: Gif[] | null; onPick(gif: Gif): void; pickLabel: string }) {
  const cols = useMemo(() => columns(gifs), [gifs]);
  return <div className="media-gif-grid">
    {cols.map((col, ci) => <div key={ci} className="media-gif-col">
      {col.map(gif => {
        const fav = isFavorite(favorites, gif.id);
        const preview = safeMediaUrl(gif.preview_url);
        return <div key={gif.id} className="media-gif-tile" style={{ aspectRatio: gif.width > 0 && gif.height > 0 ? `${gif.width} / ${gif.height}` : '4 / 3' }}>
          <button type="button" className="media-gif-pick" aria-label={`${pickLabel}: ${gif.title || 'untitled'}`} onClick={() => onPick(gif)}>
            {preview && <AnimatedImage kind="gif" src={resolveUrl(preview)} alt={gif.title} loading="lazy" draggable={false} />}
          </button>
          <button type="button" className={`media-gif-star${fav ? ' on' : ''}`} aria-label={fav ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={fav} onClick={() => void toggleFavorite(gif)}>
            <Star size={16} fill={fav ? 'currentColor' : 'none'} />
          </button>
        </div>;
      })}
    </div>)}
  </div>;
}

function Tile({ label, image, icon, onClick }: { label: string; image: string | null; icon?: React.ReactNode; onClick(): void }) {
  const url = safeMediaUrl(image);
  return <button type="button" className="media-gif-category" onClick={onClick} style={url ? { backgroundImage: `url("${resolveUrl(url)}")` } : undefined}>
    <span className="media-gif-category-label">{icon}{label}</span>
  </button>;
}

function Message({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return <div className="chat-expr-empty media-gif-empty" role="status">
    <span className="chat-gif-glyph large" aria-hidden="true">GIF</span>
    <h3>{title}</h3>
    <p>{body}</p>
    {action}
  </div>;
}

/** GIF tab of the expression picker: categories and trending, search, favourites. With provider "none" only favourites are offered. */
export function GifPicker({ onPick, pickLabel = 'Send GIF' }: { onPick(gif: Gif): void; /** What choosing a GIF does, for screen readers ("Send GIF: title"). */ pickLabel?: string }) {
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const [view, setView] = useState<View>({ kind: 'home' });
  const [provider, setProvider] = useState<GifProvider | null>(null);
  const [categories, setCategories] = useState<GifCategory[] | null>(null);
  const favorites = useMedia(s => s.favorites);
  const recent = useMedia(s => s.recentGifs);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => { void loadFavorites(); }, []);
  useEffect(() => {
    let live = true;
    request<GifCategories>('GET', '/gifs/categories').then(c => {
      if (!live) return;
      setProvider(c.provider);
      setCategories(c.categories);
    }, () => { if (live) setCategories([]); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setTerm(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const none = provider === 'none';
  const searching = term !== '' && !none;
  const source: Source | null = none ? null
    : searching ? { kind: 'search', q: term }
    : view.kind === 'trending' ? { kind: 'trending' }
    : view.kind === 'category' ? { kind: 'search', q: view.name }
    : null;
  const { listing, more, retry } = useListing(source, setProvider);
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [sourceKey(source), view.kind]);

  const title = searching ? `Results for “${term}”` : view.kind === 'trending' ? 'Trending GIFs' : view.kind === 'category' ? view.name : view.kind === 'favorites' ? 'Favorites' : view.kind === 'recent' ? 'Recent' : null;
  const matching = (list: Gif[]) => {
    const q = query.trim().toLowerCase();
    return list.filter(g => !q || g.title.toLowerCase().includes(q));
  };
  const filteredFavorites = useMemo(() => matching(favorites ?? []), [favorites, query]); // eslint-disable-line react-hooks/exhaustive-deps
  const filteredRecent = useMemo(() => matching(recent), [recent, query]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    const el = scroller.current;
    if (el && source && el.scrollTop + el.clientHeight >= el.scrollHeight - 160) more();
  };

  let body: React.ReactNode;
  if (none) {
    body = filteredFavorites.length > 0
      ? <GifGrid gifs={filteredFavorites} favorites={favorites} onPick={onPick} pickLabel={pickLabel} />
      : query.trim() ? <Message title="No matching favorites" body="GIF search isn’t set up on this server, so only your favorite GIFs can be searched." />
      : <Message title="No favorite GIFs yet" body="GIF search isn’t set up on this server, so only favorites are available. Favorite a GIF with its star to find it here." />;
  } else if (source) {
    body = <>
      {listing.gifs.length > 0 && <GifGrid gifs={listing.gifs} favorites={favorites} onPick={onPick} pickLabel={pickLabel} />}
      {listing.error && <Message title={listing.error} body="Check your connection and try again." action={<button type="button" className="btn btn-secondary btn-sm" onClick={retry}>Try again</button>} />}
      {!listing.error && !listing.loading && listing.gifs.length === 0 && <Message title="No GIFs found" body={source.kind === 'search' ? `Nothing matched “${source.q}”. Try another search.` : 'Nothing is trending right now.'} />}
      {listing.loading && <div className="media-loading" role="status">Loading GIFs…</div>}
      {!listing.loading && listing.next && <button type="button" className="btn btn-secondary btn-sm media-load-more" onClick={more}>Load more</button>}
    </>;
  } else if (view.kind === 'favorites') {
    body = filteredFavorites.length > 0 ? <GifGrid gifs={filteredFavorites} favorites={favorites} onPick={onPick} pickLabel={pickLabel} /> : <Message title="No favorite GIFs yet" body="Click the star on a GIF to keep it here." />;
  } else if (view.kind === 'recent') {
    body = filteredRecent.length > 0 ? <GifGrid gifs={filteredRecent} favorites={favorites} onPick={onPick} pickLabel={pickLabel} /> : <Message title="No recent GIFs" body="GIFs you send from the picker will show up here." />;
  } else {
    const first = favorites?.[0];
    body = <div className="media-gif-categories">
      {favorites && favorites.length > 0 && <Tile label="Favorites" image={first?.preview_url ?? null} icon={<Star size={14} fill="currentColor" />} onClick={() => setView({ kind: 'favorites' })} />}
      {recent.length > 0 && <Tile label="Recent" image={recent[0]?.preview_url ?? null} icon={<Clock size={14} />} onClick={() => setView({ kind: 'recent' })} />}
      <Tile label="Trending GIFs" image={categories?.[0]?.image ?? null} icon={<TrendingUp size={14} />} onClick={() => setView({ kind: 'trending' })} />
      {(categories ?? []).map(c => <Tile key={c.name} label={c.name} image={c.image} onClick={() => setView({ kind: 'category', name: c.name })} />)}
      {categories === null && <div className="media-loading" role="status">Loading categories…</div>}
    </div>;
  }

  return <div className="chat-expr-panel media-panel" role="tabpanel" aria-label="GIFs">
    <div className="chat-expr-search">
      {view.kind !== 'home' && !query
        ? <button type="button" aria-label="Back to categories" onClick={() => setView({ kind: 'home' })}><ArrowLeft size={18} /></button>
        : <Search size={18} aria-hidden="true" />}
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder={none ? 'Search favorites' : 'Search for GIFs'} aria-label="Search GIFs" spellCheck={false} autoFocus />
      {query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><X size={16} /></button>}
    </div>
    {title && !none && <div className="media-panel-title">{title}</div>}
    <div ref={scroller} className="media-panel-scroll" onScroll={onScroll}>{body}</div>
  </div>;
}
