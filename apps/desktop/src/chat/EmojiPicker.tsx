import { useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { Clock, Copy, Dog, Flag, Hand, Lightbulb, Pizza, Plane, Search, Smile, Star, Trophy, Hash, X } from 'lucide-react';
import { BottomSheet, copyText, Popout, scrollBehavior, useContextMenu, usePhone } from './shell';
import { SuperReactToggle } from '../perks/SuperReactions';
import { customEmojiId, getFavoriteEmoji, getRecentEmoji, getSkinTone, isFavoriteEmoji, setSkinTone, toggleFavoriteEmoji, useEmojiDb, type EmojiEntry } from './emojiData';
import { CustomEmojiCell, CustomEmojiRail, CustomEmojiSections, CustomSearchResults, hasCustomResults, usePickerSections, type CustomHover, type CustomMenu, type CustomPick } from '../emoji/PickerSections';
import { emojiMarkup } from '../emoji/store';
import { usePrefs } from '../ui/prefs';

/** Unicode (`id` null) or a server's custom emoji. */
export interface PickedEmoji { id: string | null; name: string; animated?: boolean }

const CATEGORY_ICONS: Record<string, typeof Smile> = {
  recent: Clock, people: Smile, body: Hand, nature: Dog, food: Pizza, activity: Trophy, travel: Plane, objects: Lightbulb, symbols: Hash, flags: Flag,
};
const TONE_SWATCH = ['#ffc83d', '#f7d6bd', '#d9ac81', '#b57e52', '#8a5a3a', '#4d3427'];

function variant(e: EmojiEntry, tone: number): string {
  if (tone === 0 || e.skins.length === 0) return e.emoji;
  return e.skins.find(s => s.tone === tone)?.emoji ?? e.emoji;
}

export function EmojiPicker({ onPick, autoFocus = true, embedded = false, reactionChannelId, superReactions = false }: {
  /** `burst` is true when the Super Reaction switch is on (only with `superReactions`). */
  onPick: (e: PickedEmoji, burst: boolean) => void;
  autoFocus?: boolean;
  /** Reacting in this channel: hides emoji the server would refuse there. */
  reactionChannelId?: string;
  /** Inside ExpressionPicker: fills its parent and drops the popout chrome. */
  embedded?: boolean;
  /** Reaction pickers: show the Super Reaction switch. */
  superReactions?: boolean;
}) {
  const db = useEmojiDb();
  const [query, setQuery] = useState('');
  const [tone, setTone] = useState(getSkinTone);
  const [toneOpen, setToneOpen] = useState(false);
  const [hover, setHover] = useState<{ emoji: string; label: string; src?: string } | null>(null);
  const sections = usePickerSections(reactionChannelId);
  const [active, setActive] = useState('recent');
  const [burst, setBurst] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const recentAll = useMemo(() => getRecentEmoji(), []);
  useEffect(() => { getFavoriteEmoji(); }, []); // moves favourites saved before they synced into the prefs, once
  const favoritesAll = usePrefs(s => s.emojiFavorites);
  // Custom entries show only while usable here (a server left, a reaction channel that refuses them).
  const customById = useMemo(() => new Map(sections.flatMap(s => s.emojis.map(e => [e.id, e] as const))), [sections]);
  const usable = (list: string[]) => list.filter(e => { const id = customEmojiId(e); return !id || customById.has(id); });
  const recent = usable(recentAll);
  const favorites = usable(favoritesAll);
  const menu = useContextMenu();
  // Right-click (a long press on touch): Favorite / Unfavorite and Copy, as in Discord's picker. Custom emoji copy as their markup.
  const favoriteMenu = (ch: string) => (ev: MouseEvent) => {
    menu.open(ev, [
      { id: 'favorite', label: isFavoriteEmoji(favoritesAll, ch) ? 'Unfavorite emoji' : 'Favorite emoji', icon: <Star size={16} />, onSelect: () => toggleFavoriteEmoji(ch) },
      { id: 'copy', label: 'Copy emoji', icon: <Copy size={16} />, onSelect: () => copyText(ch) },
    ]);
  };
  const customMenu: CustomMenu = e => favoriteMenu(emojiMarkup(e));

  useEffect(() => { if (autoFocus) input.current?.focus(); }, [autoFocus]);

  const results = useMemo(() => (db && query.trim() ? db.search(query, 120) : null), [db, query]);

  const pickCustom = (e: CustomPick) => onPick(e, superReactions && burst);
  const hoverCustom = (h: CustomHover) => setHover({ emoji: '', label: h.label, src: h.src });

  // Not counted here: a sent message or an added reaction counts it (messageStore), so a picked emoji is not counted twice.
  function pick(emoji: string) {
    onPick({ id: null, name: emoji }, superReactions && burst);
  }

  function scrollTo(id: string) {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-cat="${id}"]`);
    if (el && scroller.current) scroller.current.scrollTo({ top: el.offsetTop - scroller.current.offsetTop, behavior: scrollBehavior() });
  }

  function onScroll() {
    const root = scroller.current;
    if (!root) return;
    const secs = [...root.querySelectorAll<HTMLElement>('[data-cat]')];
    let cur = secs[0]?.dataset.cat ?? 'recent';
    for (const s of secs) if (s.offsetTop - root.offsetTop <= root.scrollTop + 8) cur = s.dataset.cat ?? cur;
    setActive(cur);
  }

  const cell = (e: EmojiEntry) => {
    const ch = variant(e, tone);
    return <button key={e.order} type="button" className="chat-emoji-cell" aria-label={e.label} onMouseEnter={() => setHover({ emoji: ch, label: e.shortcodes[0] ? `:${e.shortcodes[0]}:` : e.label })} onClick={() => pick(ch)} data-long-press="" onContextMenu={favoriteMenu(ch)}>{ch}</button>;
  };
  /** A Favorites / Frequently Used entry: a glyph, or a custom emoji's markup (already checked usable). */
  const plainCell = (ch: string) => {
    const custom = customById.get(customEmojiId(ch) ?? '');
    if (custom) return <CustomEmojiCell key={ch} emoji={custom} onPick={pickCustom} onHover={hoverCustom} onMenu={customMenu} />;
    return <button key={ch} type="button" className="chat-emoji-cell" onMouseEnter={() => setHover({ emoji: ch, label: '' })} onClick={() => pick(ch)} data-long-press="" onContextMenu={favoriteMenu(ch)}>{ch}</button>;
  };

  return <div className={`chat-emoji-picker${embedded ? ' embedded' : ''}`} role={embedded ? 'tabpanel' : 'dialog'} aria-label="Emoji picker">
    <div className="chat-emoji-top">
      <div className="chat-emoji-search">
        <input ref={input} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => {
          // Enter picks the top search result (the first cell shown, custom emoji included), as in Discord.
          if (e.key !== 'Enter' || !results || e.nativeEvent.isComposing) return;
          e.preventDefault();
          scroller.current?.querySelector<HTMLButtonElement>('button')?.click();
        }} placeholder="Find the perfect emoji" aria-label="Search emoji" spellCheck={false} />
        {query ? <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><X size={16} /></button> : <Search size={16} aria-hidden="true" />}
      </div>
      {superReactions && <SuperReactToggle on={burst} onChange={setBurst} />}
    </div>
    <div className="chat-emoji-body">
      <nav className="chat-emoji-cats" aria-label="Categories">
        {favorites.length > 0 && <button type="button" className={active === 'favorites' && !results ? 'active' : ''} aria-label="Favorites" title="Favorites" onClick={() => { setQuery(''); requestAnimationFrame(() => scrollTo('favorites')); }}><Star size={20} /></button>}
        <button type="button" className={active === 'recent' && !results ? 'active' : ''} aria-label="Frequently Used" title="Frequently Used" onClick={() => { setQuery(''); requestAnimationFrame(() => scrollTo('recent')); }}><Clock size={20} /></button>
        <CustomEmojiRail sections={sections} active={results ? '' : active} onJump={key => { setQuery(''); requestAnimationFrame(() => scrollTo(key)); }} />
        {(db?.categories ?? []).map(c => {
          const Icon = CATEGORY_ICONS[c.id] ?? Smile;
          return <button key={c.id} type="button" className={active === c.id && !results ? 'active' : ''} aria-label={c.label} title={c.label} onClick={() => { setQuery(''); requestAnimationFrame(() => scrollTo(c.id)); }}><Icon size={20} /></button>;
        })}
      </nav>
      <div className="chat-emoji-scroll" ref={scroller} onScroll={onScroll}>
        {!db && <div className="chat-emoji-empty">Loading…</div>}
        {db && results && (results.length || hasCustomResults(sections, query)
          ? <section><h3 className="chat-emoji-heading">Search Results</h3><CustomSearchResults sections={sections} query={query} onPick={pickCustom} onHover={hoverCustom} onMenu={customMenu} /><div className="chat-emoji-grid">{results.map(cell)}</div></section>
          : <div className="chat-emoji-empty">No emoji match your search.</div>)}
        {db && !results && <>
          {favorites.length > 0 && <section data-cat="favorites"><h3 className="chat-emoji-heading emoji-guild-heading"><Star size={16} aria-hidden="true" />Favorites</h3><div className="chat-emoji-grid">{favorites.map(plainCell)}</div></section>}
          <section data-cat="recent"><h3 className="chat-emoji-heading emoji-guild-heading"><Clock size={16} aria-hidden="true" />Frequently Used</h3>
            {recent.length === 0 ? <div className="chat-emoji-none">Emoji you use will show up here.</div> :
              <div className="chat-emoji-grid">{recent.map(plainCell)}</div>}
          </section>
          <CustomEmojiSections sections={sections} onPick={pickCustom} onHover={hoverCustom} onMenu={customMenu} />
          {db.categories.map(c => <section key={c.id} data-cat={c.id}><h3 className="chat-emoji-heading">{c.label}</h3><div className="chat-emoji-grid">{c.emoji.map(cell)}</div></section>)}
        </>}
      </div>
    </div>
    <div className="chat-emoji-footer">
      <div className="chat-emoji-preview">{hover ? <>{hover.src ? <img className="chat-emoji-preview-glyph emoji-preview-img" src={hover.src} alt="" /> : <span className="chat-emoji-preview-glyph">{hover.emoji}</span>}<span>{hover.label}</span></> : <span className="chat-emoji-hint">Pick an emoji</span>}</div>
      <div className="chat-emoji-tone">
        <button type="button" aria-label="Skin tone" aria-expanded={toneOpen} onClick={() => setToneOpen(v => !v)}><span className="chat-tone-dot" style={{ background: TONE_SWATCH[tone] }} /></button>
        {toneOpen && <div className="chat-emoji-tone-menu" role="menu">
          {TONE_SWATCH.map((c, i) => <button key={c} type="button" role="menuitemradio" aria-checked={tone === i} aria-label={i === 0 ? 'Default skin tone' : `Skin tone ${i}`} className={tone === i ? 'active' : ''} onClick={() => { setTone(i); setSkinTone(i); setToneOpen(false); }}><span className="chat-tone-dot" style={{ background: c }} /></button>)}
        </div>}
      </div>
    </div>
  </div>;
}

export function EmojiPickerPopout({ anchor, open, onClose, onPick, reactionChannelId, superReactions }: { anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void; onPick: (e: PickedEmoji, burst: boolean) => void; reactionChannelId?: string; superReactions?: boolean }) {
  const phone = usePhone();
  const picker = <EmojiPicker onPick={onPick} reactionChannelId={reactionChannelId} superReactions={superReactions} />;
  if (phone) return <BottomSheet open={open} onClose={onClose} label="Emoji" className="sheet-picker">{picker}</BottomSheet>;
  return <Popout anchor={anchor} open={open} onClose={onClose} side="top">{picker}</Popout>;
}
