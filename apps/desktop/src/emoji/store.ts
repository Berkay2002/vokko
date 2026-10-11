// Custom emoji of every guild the user is in, kept current from READY / GUILD_CREATE / GUILD_EMOJIS_UPDATE / GUILD_DELETE.
// Separate from the app store so the emoji feature owns its data; the guild list and member roles still come from there.

import { useMemo } from 'react';
import { create } from 'zustand';
import { gateway } from '../api/gateway';
import { MOCK, REST_BASE } from '../api/config';
import { useStore, type AppState } from '../api/store';
import type { Guild, GuildEmoji, Snowflake } from '../api/types';

export interface EmojiState {
  /** guild id → its emoji (server order: oldest first). */
  byGuild: Record<Snowflake, GuildEmoji[]>;
}

export const emojiStore = create<EmojiState>()(() => ({ byGuild: {} }));

export function setGuildEmojis(guildId: Snowflake, emojis: GuildEmoji[] | undefined): void {
  emojiStore.setState(s => ({ byGuild: { ...s.byGuild, [guildId]: emojis ?? [] } }));
}

let installed = false;
/** Subscribes the store to the gateway once (called on import). */
export function installEmojiSync(): void {
  if (installed) return;
  installed = true;
  gateway.on('READY', ready => emojiStore.setState({ byGuild: Object.fromEntries(ready.guilds.map(g => [g.id, g.emojis ?? []])) }));
  gateway.on('GUILD_CREATE', guild => setGuildEmojis(guild.id, guild.emojis));
  gateway.on('GUILD_EMOJIS_UPDATE', ({ guild_id, emojis }) => setGuildEmojis(guild_id, emojis));
  gateway.on('GUILD_DELETE', ({ id }) =>
    emojiStore.setState(s => {
      const { [id]: _gone, ...rest } = s.byGuild;
      void _gone;
      return { byGuild: rest };
    }),
  );
}
installEmojiSync();

/** The emoji with this id among the user's guilds, with its guild id. */
export function findEmoji(id: Snowflake, state: EmojiState = emojiStore.getState()): { emoji: GuildEmoji; guildId: Snowflake } | null {
  for (const [guildId, list] of Object.entries(state.byGuild)) {
    const emoji = list.find(e => e.id === id);
    if (emoji) return { emoji, guildId };
  }
  return null;
}

/**
 * Image URL for `<:name:id>` / a reaction. Known emoji use their own `url`; others (a guild the viewer is not in) use the public
 * `GET /emojis/{id}` route. The mock has no such route, so an unknown emoji there yields null and renders as `:name:`.
 */
export function customEmojiUrl(id: Snowflake, state: EmojiState = emojiStore.getState()): string | null {
  const known = findEmoji(id, state);
  if (known) return known.emoji.url;
  return MOCK ? null : `${REST_BASE}/emojis/${id}`;
}

/** Re-renders when any guild's emoji change; the resolver only changes identity then. */
export function useCustomEmojiUrl(): (id: Snowflake) => string | null {
  const byGuild = emojiStore(s => s.byGuild);
  return useMemo(() => (id: Snowflake) => customEmojiUrl(id, { byGuild }), [byGuild]);
}

export interface EmojiSection {
  guild: Guild;
  emojis: GuildEmoji[];
}

/** Whether `roles` (a member's) may use the emoji: unrestricted, or holding one of its roles. */
export function canUseEmoji(emoji: GuildEmoji, memberRoles: readonly Snowflake[] | undefined): boolean {
  if (emoji.roles.length === 0) return true;
  return !!memberRoles && emoji.roles.some(r => memberRoles.includes(r));
}

/**
 * Picker / autocomplete sections: every guild in rail order whose emoji the user may use (role-restricted ones only with a role).
 * `firstGuildId` (the current server) goes first, like Discord. Vokko gives everyone the Nitro perk, so all guilds count everywhere.
 */
export function usableSections(app: Pick<AppState, 'guilds' | 'guildOrder' | 'members' | 'me'>, emoji: EmojiState, firstGuildId: Snowflake | null): EmojiSection[] {
  const meId = app.me?.id;
  const order = firstGuildId ? [firstGuildId, ...app.guildOrder.filter(id => id !== firstGuildId)] : app.guildOrder;
  const out: EmojiSection[] = [];
  for (const id of order) {
    const guild = app.guilds[id];
    const list = emoji.byGuild[id];
    if (!guild || !list?.length) continue;
    const roles = meId ? app.members[id]?.[meId]?.roles : undefined;
    const usable = list.filter(e => e.available && canUseEmoji(e, roles));
    if (usable.length) out.push({ guild, emojis: usable });
  }
  return out;
}

export function useUsableSections(firstGuildId: Snowflake | null): EmojiSection[] {
  const byGuild = emojiStore(s => s.byGuild);
  const guilds = useStore(s => s.guilds);
  const guildOrder = useStore(s => s.guildOrder);
  const members = useStore(s => s.members);
  const me = useStore(s => s.me);
  return useMemo(() => usableSections({ guilds, guildOrder, members, me }, { byGuild }, firstGuildId), [guilds, guildOrder, members, me, byGuild, firstGuildId]);
}

/** Case-insensitive name search over the sections: prefix matches first, then substring matches. */
export function searchCustomEmoji(sections: EmojiSection[], query: string, limit = 60): { emoji: GuildEmoji; guild: Guild }[] {
  const q = query.trim().toLowerCase().replace(/^:|:$/g, '');
  if (!q) return [];
  const hits: { emoji: GuildEmoji; guild: Guild; rank: number }[] = [];
  for (const s of sections) {
    for (const emoji of s.emojis) {
      const name = emoji.name.toLowerCase();
      const at = name.indexOf(q);
      if (at >= 0) hits.push({ emoji, guild: s.guild, rank: name === q ? 0 : at === 0 ? 1 : 2 });
    }
  }
  return hits.sort((a, b) => a.rank - b.rank).slice(0, limit).map(({ emoji, guild }) => ({ emoji, guild }));
}

/** Message-content form of a custom emoji. */
export function emojiMarkup(emoji: Pick<GuildEmoji, 'id' | 'name' | 'animated'>): string {
  return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
}
