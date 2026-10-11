// The only module in src/chat that imports shell-owned code (src/api, src/ui). Everything else in the chat area goes through here,
// so contract drift between the shell and the chat area is fixed in one file.
import { useMemo } from 'react';
import { useStore } from '../api/store';
import type { Channel, Guild, GuildMember, ReadState, Role, Snowflake, User } from '../api/types';

export { request, uploadAttachment, ApiRequestError } from '../api/rest';
export { gateway } from '../api/gateway';
export { displayName, roleColor, defaultAvatarUrl } from '../api/store';
export { Tooltip, Popout, Modal, useContextMenu } from '../ui';
export type { MenuItem } from '../ui';

const NO_MEMBERS: Record<Snowflake, GuildMember> = {};

export function useMe(): User | null { return useStore(s => s.me); }
export function useChannel(channelId: Snowflake): Channel | undefined { return useStore(s => s.channels[channelId]); }
export function useGuild(guildId: Snowflake | null | undefined): Guild | undefined { return useStore(s => (guildId ? s.guilds[guildId] : undefined)); }
export function useGuildMembers(guildId: Snowflake | null | undefined): Record<Snowflake, GuildMember> { return useStore(s => (guildId ? s.members[guildId] : undefined)) ?? NO_MEMBERS; }
export function useUsers(): Record<Snowflake, User> { return useStore(s => s.users); }
export function useReadState(channelId: Snowflake): ReadState | undefined { return useStore(s => s.readStates[channelId]); }
export function usePresences() { return useStore(s => s.presences); }

/** Channels of a guild, in position order (for #channel autocomplete and mention rendering). */
export function useGuildChannels(guildId: Snowflake | null | undefined): Channel[] {
  const all = useStore(s => s.channels);
  return useMemo(() => (guildId ? Object.values(all).filter(c => c.guild_id === guildId).sort((a, b) => a.position - b.position) : []), [all, guildId]);
}

export function guildRoles(guild: Guild | undefined): Role[] { return guild?.roles ?? []; }
