// Ranking for the composer's `@` / `#` autocomplete and the search `in:` picker (pure, so it is unit tested).
import { ChannelType, type Channel } from '../api/types';

/** 0: the text starts with the query, 1: a word in it does, 2: it contains it, 3: no match. An empty query matches everything at 0. */
export function matchRank(q: string, ...texts: string[]): number {
  if (!q) return 0;
  let best = 3;
  for (const t of texts.map(t => t.toLowerCase())) {
    if (t.startsWith(q)) return 0;
    if (t.split(/[\s_.\-]+/).some(w => w.startsWith(q))) best = Math.min(best, 1);
    else if (t.includes(q)) best = Math.min(best, 2);
  }
  return best;
}

/** Channels a `<#id>` mention can point at, like Discord: text, announcement, forum, media, voice, stage and threads (the store only holds channels the viewer can see). */
const MENTIONABLE = new Set<number>([
  ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, 16 /* GuildMedia */, ChannelType.GuildVoice, ChannelType.GuildStage,
  ChannelType.AnnouncementThread, ChannelType.PublicThread, ChannelType.PrivateThread,
]);

/** Mentionable channels matching `q`, better matches first, otherwise in the given (position) order. */
export function mentionableChannels(channels: Channel[], q: string, limit: number): Channel[] {
  return channels
    .map((c, i) => ({ c, i, r: MENTIONABLE.has(c.type) ? matchRank(q, c.name ?? '') : 3 }))
    .filter(x => x.r < 3)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map(x => x.c);
}

export interface Person { id: string; name: string; username: string }
export interface MentionRole { id: string; name: string }
export type UserSuggestion<P, R> = { kind: 'user'; person: P } | { kind: 'role'; role: R } | { kind: 'special'; name: 'everyone' | 'here' };

/** Rows of the `@` popup: members (name or username word-start matches first, at most 8 when roles or @everyone/@here also match), then roles, then @everyone/@here (only for viewers allowed to use them), 12 rows in all. */
export function userSuggestions<P extends Person, R extends MentionRole>(people: P[], roles: R[], q: string, canEveryone: boolean): UserSuggestion<P, R>[] {
  const rank = <T>(items: T[], texts: (t: T) => string[], name: (t: T) => string) => items
    .map(t => ({ t, r: matchRank(q, ...texts(t)) }))
    .filter(x => x.r < 3)
    .sort((a, b) => a.r - b.r || name(a.t).localeCompare(name(b.t)))
    .map(x => x.t);
  const specials = canEveryone ? (['everyone', 'here'] as const).filter(s => s.startsWith(q)) : [];
  const matchedRoles = rank(roles, r => [r.name], r => r.name);
  const members = rank(people, p => [p.name, p.username], p => p.name).slice(0, specials.length || matchedRoles.length ? 8 : 10);
  return [
    ...members.map(person => ({ kind: 'user' as const, person })),
    ...matchedRoles.slice(0, 12 - members.length - specials.length).map(role => ({ kind: 'role' as const, role })),
    ...specials.map(name => ({ kind: 'special' as const, name })),
  ];
}
