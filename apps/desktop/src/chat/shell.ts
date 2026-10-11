// The only module in src/chat that imports shell-owned code (src/api, src/ui). Everything else in the chat area goes through here,
// so contract drift between the shell and the chat area is fixed in one file.
import { useMemo } from 'react';
import { useStore } from '../api/store';
import type { Channel, Guild, GuildMember, ReadState, Relationship, Snowflake, User } from '../api/types';

export { request, uploadAttachment, resolveUrl, ApiRequestError } from '../api/rest';
export { gateway } from '../api/gateway';
export { displayName, roleColor, avatarUrl, dmName, guildIconUrl, guildInitials } from '../api/store';
export { markGuildRead, joinGuildWithInvite } from '../shell/actions';
export { Tooltip, Popout, Modal, useContextMenu } from '../ui';
export type { MenuItem } from '../ui';

const NO_MEMBERS: Record<Snowflake, GuildMember> = {};

export function useMe(): User | null { return useStore(s => s.me); }
export function useChannel(channelId: Snowflake): Channel | undefined { return useStore(s => s.channels[channelId]); }
export function useGuild(guildId: Snowflake | null | undefined): Guild | undefined { return useStore(s => (guildId ? s.guilds[guildId] : undefined)); }
export function useGuildMembers(guildId: Snowflake | null | undefined): Record<Snowflake, GuildMember> { return useStore(s => (guildId ? s.members[guildId] : undefined)) ?? NO_MEMBERS; }
export function useUsers(): Record<Snowflake, User> { return useStore(s => s.users); }
export function useReadState(channelId: Snowflake): ReadState | undefined { return useStore(s => s.readStates[channelId]); }
export function useRelationship(userId: Snowflake | null | undefined): Relationship | undefined { return useStore(s => (userId ? s.relationships[userId] : undefined)); }
export function useGuilds(): Record<Snowflake, Guild> { return useStore(s => s.guilds); }

/** Guilds where `userId` is a loaded member (client-side fallback when GET /users/{id}/profile is unavailable). */
export function useMutualGuildsFromStore(userId: Snowflake | null | undefined): Guild[] {
  return useStore(s => (userId ? s.guildOrder.filter(id => s.members[id]?.[userId]).map(id => s.guilds[id]!).filter(Boolean) : []));
}

/**
 * Message display density. The shell will own the appearance setting; until it lands every chat view is cozy. `ChatProvider` reads this
 * once and exposes it as `useChat().compact`, so adding compact layout later only touches CSS and MessageItem's header placement.
 */
export function useCompactMode(): boolean { return false; }

/** Channels of a guild, in position order (for #channel autocomplete and mention rendering). */
export function useGuildChannels(guildId: Snowflake | null | undefined): Channel[] {
  const all = useStore(s => s.channels);
  return useMemo(() => (guildId ? Object.values(all).filter(c => c.guild_id === guildId).sort((a, b) => a.position - b.position) : []), [all, guildId]);
}
