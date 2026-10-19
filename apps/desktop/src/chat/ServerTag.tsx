import { useRef, useState } from 'react';
import { Hexagon, type LucideIcon } from 'lucide-react';
import type { User, UserPrimaryGuild } from '../api/types';
import { BADGES } from '../perks/catalog';
import { Popout, go, guildIconUrl, guildInitials, guildPath, useGuild, useGuildCounts } from './shell';
import { snowflakeToMs } from './util';

/** Vokko's own open badge set (src/perks/catalog.ts). `UserPrimaryGuild.badge` is one of these ids; an unknown id renders the fallback hexagon. */
export const SERVER_TAG_BADGES: Record<string, LucideIcon> = Object.fromEntries(BADGES.map(b => [b.id, b.Icon]));

const hex = (n: number): string | undefined => (n > 0 ? `#${(n & 0xffffff).toString(16).padStart(6, '0')}` : undefined);

export function ServerTagBadge({ badge, size = 12, color }: { badge: string; size?: number; color?: string }) {
  const Icon = SERVER_TAG_BADGES[badge] ?? Hexagon;
  return <Icon size={size} strokeWidth={2.5} className="chat-server-tag-badge" style={color ? { color } : undefined} aria-hidden="true" />;
}

function TagCard({ tag, onClose }: { tag: UserPrimaryGuild; onClose(): void }) {
  const guild = useGuild(tag.guild_id);
  const counts = useGuildCounts(tag.guild_id);
  const created = new Date(snowflakeToMs(tag.guild_id)).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const icon = guild ? guildIconUrl(guild) : null;
  const banner = hex(tag.color_primary) ?? 'var(--chat-brand)';
  return <div className="chat-tag-card" role="dialog" aria-label={`${guild?.name ?? 'Server'} tag`}>
    <div className="chat-tag-card-banner" style={{ background: banner }} />
    <span className="chat-tag-card-icon">{icon ? <img src={icon} alt="" /> : guildInitials(guild?.name ?? tag.tag)}</span>
    <div className="chat-tag-card-body">
      <div className="chat-tag-card-name">{guild?.name ?? 'Unknown server'}</div>
      {guild && <div className="chat-tag-card-stats">
        <span><i className="online" aria-hidden="true" />{counts.online} online</span>
        <span><i aria-hidden="true" />{counts.total} {counts.total === 1 ? 'member' : 'members'}</span>
      </div>}
      <div className="chat-tag-card-sub">Created: {created}</div>
      <div className="chat-tag-card-sub">Members of this server can wear its tag next to their name.</div>
      <div className="chat-tag-card-chip"><span className="chat-server-tag static"><ServerTagBadge badge={tag.badge} color={hex(tag.color_primary)} /><span>{tag.tag}</span></span></div>
    </div>
    <div className="chat-tag-card-actions">
      <button type="button" className="chat-tag-card-go" disabled={!guild} onClick={() => { onClose(); if (guild) go(guildPath(guild.id)); }}>Go to Server</button>
    </div>
  </div>;
}

/**
 * The chip next to a name ("OAI"): badge glyph + up to 4 letters of the author's server tag. No tooltip (the reference has none); click opens the tag card.
 * Used for author names and reply previews here; the member list in src/shell can render the same component.
 */
export function ServerTag({ user, className }: { user: Pick<User, 'primary_guild'>; className?: string }) {
  const tag = user.primary_guild;
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!tag || !tag.tag) return null;
  return <>
    <button ref={ref} type="button" className={`chat-server-tag${className ? ` ${className}` : ''}`} aria-label={`Server tag ${tag.tag}`}
      onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>
      <ServerTagBadge badge={tag.badge} color={hex(tag.color_primary)} />
      <span>{tag.tag}</span>
    </button>
    <Popout anchor={ref} open={open} onClose={() => setOpen(false)} side="right" align="start" className="chat-tag-popout">
      <TagCard tag={tag} onClose={() => setOpen(false)} />
    </Popout>
  </>;
}
