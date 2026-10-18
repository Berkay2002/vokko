import { useEffect, useMemo, useState } from 'react';
import { Clock, Search, Star, Sticker as StickerIcon, X } from 'lucide-react';
import { channelPermissions, memberLike } from '../api/permissions';
import type { Snowflake, Sticker } from '../api/types';
import { canUseSticker, groupStickers } from './helpers';
import { resolveStickers } from './lists';
import { appStore, guildIconUrl, guildInitials, resolveUrl, usePrefs, useStore } from './shell';
import { recordSticker, refreshStickers, toggleFavoriteSticker, useMedia } from './store';

/**
 * Sticker tab of the expression picker: the stickers of every server the user is in, grouped under a server header (the current
 * channel's server first), searchable by name and tags. Hovering a sticker shows it larger with its name.
 */
export function StickerPicker({ channelId, onPick: choose }: { channelId: Snowflake; onPick(sticker: Sticker): void }) {
  const onPick = (sticker: Sticker) => { recordSticker(sticker.id); choose(sticker); };
  const [query, setQuery] = useState('');
  const [hover, setHover] = useState<Sticker | null>(null);
  const stickers = useMedia(s => s.stickers);
  const recentIds = useMedia(s => s.recentStickers);
  const favoriteIds = usePrefs(s => s.stickerFavorites);
  const guilds = useStore(s => s.guilds);
  const order = useStore(s => s.guildOrder);
  const channel = useStore(s => s.channels[channelId]);
  const me = useStore(s => s.me);
  const member = useStore(s => (channel?.guild_id && me ? s.members[channel.guild_id]?.[me.id] : undefined));
  const currentGuildId = channel?.guild_id ?? null;

  useEffect(() => { void refreshStickers(); }, []);

  const groups = useMemo(() => groupStickers(order, stickers, guilds, query, currentGuildId), [order, stickers, guilds, query, currentGuildId]);
  const favorites = useMemo(() => resolveStickers(favoriteIds, stickers), [favoriteIds, stickers]);
  const recent = useMemo(() => resolveStickers(recentIds, stickers).slice(0, 8), [recentIds, stickers]);
  const total = useMemo(() => Object.values(stickers).reduce((n, list) => n + list.length, 0), [stickers]);

  // null = a DM (everything allowed); in a server the channel's permissions decide about stickers of other servers.
  const bits = useMemo(() => {
    const guild = currentGuildId ? appStore.getState().guilds[currentGuildId] : undefined;
    return guild && member && channel ? channelPermissions(guild, memberLike(member), channel) : null;
  }, [currentGuildId, member, channel]);

  const cell = (sticker: Sticker) => {
    const usable = canUseSticker(sticker, currentGuildId, bits);
    const fav = favoriteIds.includes(sticker.id);
    return <div key={sticker.id} className="media-sticker-item">
      <button type="button" className={`media-sticker-cell${usable ? '' : ' locked'}`} aria-label={sticker.name} aria-disabled={!usable || undefined}
        title={usable ? sticker.name : `${sticker.name} — you can’t use stickers from other servers here`}
        onMouseEnter={() => setHover(sticker)} onFocus={() => setHover(sticker)} onClick={() => { if (usable) onPick(sticker); }}>
        <img src={resolveUrl(sticker.url)} alt="" loading="lazy" draggable={false} />
      </button>
      <button type="button" className={`media-sticker-star${fav ? ' on' : ''}`} aria-label={fav ? `Remove ${sticker.name} from favorites` : `Add ${sticker.name} to favorites`} aria-pressed={fav}
        onClick={() => toggleFavoriteSticker(sticker.id)}>
        <Star size={14} fill={fav ? 'currentColor' : 'none'} />
      </button>
    </div>;
  };
  const shelf = (id: string, label: string, icon: React.ReactNode, list: Sticker[]) => list.length > 0 && <section key={id} className="media-sticker-group" aria-label={label}>
    <h3 className="media-sticker-header"><span className="media-sticker-server-icon" aria-hidden="true">{icon}</span>{label}</h3>
    <div className="media-sticker-grid">{list.map(cell)}</div>
  </section>;
  const searching = query.trim() !== '';

  return <div className="chat-expr-panel media-panel" role="tabpanel" aria-label="Stickers">
    <div className="chat-expr-search">
      <Search size={18} aria-hidden="true" />
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Find the perfect sticker" aria-label="Search stickers" spellCheck={false} autoFocus />
      {query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><X size={16} /></button>}
    </div>
    <div className="media-panel-scroll" onMouseLeave={() => setHover(null)}>
      {!searching && shelf('favorites', 'Favorites', <Star size={12} fill="currentColor" />, favorites)}
      {!searching && shelf('recent', 'Recent', <Clock size={12} />, recent)}
      {groups.map(group => {
        const guild = guilds[group.guildId];
        const icon = guild ? guildIconUrl(guild) : null;
        return <section key={group.guildId} className="media-sticker-group" aria-label={group.name}>
          <h3 className="media-sticker-header">
            <span className="media-sticker-server-icon" aria-hidden="true">{icon ? <img src={resolveUrl(icon)} alt="" draggable={false} /> : guildInitials(group.name)}</span>
            {group.name}
          </h3>
          <div className="media-sticker-grid">
            {group.stickers.map(cell)}
          </div>
        </section>;
      })}
      {groups.length === 0 && <div className="chat-expr-empty media-sticker-empty" role="status">
        <StickerIcon size={48} aria-hidden="true" />
        <h3>{total === 0 ? 'No stickers yet' : 'No stickers found'}</h3>
        <p>{total === 0 ? 'Stickers added to your servers will show up here.' : `Nothing matched “${query.trim()}”. Try a different word.`}</p>
      </div>}
    </div>
    {hover && <div className="media-sticker-preview" aria-live="polite">
      <img src={resolveUrl(hover.url)} alt="" draggable={false} />
      <div className="media-sticker-preview-text">
        <b>{hover.name}</b>
        <span>{hover.description || hover.tags.split(',').map(t => t.trim()).filter(Boolean).join(', ')}</span>
      </div>
    </div>}
  </div>;
}
