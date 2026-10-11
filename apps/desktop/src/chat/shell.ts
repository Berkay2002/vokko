// The only module in src/chat that imports shell-owned code (src/api, src/ui). Everything else in the chat area goes through here,
// so contract drift between the shell and the chat area is fixed in one file.
import { useMemo } from 'react';
import { appStore, useStore } from '../api/store';
import { usePrefs } from '../ui';
import type { Channel, Guild, GuildMember, ReadState, Relationship, Snowflake, User } from '../api/types';

export { request, uploadAttachment, resolveUrl, ApiRequestError } from '../api/rest';
export { gateway } from '../api/gateway';
export { displayName, roleColor, avatarUrl, dmName, guildIconUrl, guildInitials } from '../api/store';
export { markGuildRead, joinGuildWithInvite } from '../shell/actions';
export { go, guildPath } from '../shell/nav';
export { openModal } from '../shell/modalStore';
export { usePermissions } from '../shell/usePermissions';
export { Perm } from '../api/permissions';
export { Tooltip, Popout, Modal, useContextMenu, useLayer, useOutsideClose, placeAtPoint } from '../ui';
export type { MenuItem } from '../ui';

const NO_MEMBERS: Record<Snowflake, GuildMember> = {};

export function useMe(): User | null { return useStore(s => s.me); }
export function useChannel(channelId: Snowflake): Channel | undefined { return useStore(s => s.channels[channelId] ?? s.threads[channelId]); }
export function useGuild(guildId: Snowflake | null | undefined): Guild | undefined { return useStore(s => (guildId ? s.guilds[guildId] : undefined)); }
export function useGuildMembers(guildId: Snowflake | null | undefined): Record<Snowflake, GuildMember> { return useStore(s => (guildId ? s.members[guildId] : undefined)) ?? NO_MEMBERS; }
export function useUsers(): Record<Snowflake, User> { return useStore(s => s.users); }
export function useReadState(channelId: Snowflake): ReadState | undefined { return useStore(s => s.readStates[channelId]); }
export function useRelationship(userId: Snowflake | null | undefined): Relationship | undefined { return useStore(s => (userId ? s.relationships[userId] : undefined)); }
export function useGuilds(): Record<Snowflake, Guild> { return useStore(s => s.guilds); }

/** Guild member count (the READY count when known) and how many of the *loaded* members are not offline; `online` is a lower bound for big guilds. */
export function useGuildCounts(guildId: Snowflake | null | undefined): { total: number; online: number } {
  const members = useGuildMembers(guildId);
  const presences = useStore(s => s.presences);
  const memberCount = useStore(s => (guildId ? s.memberCounts[guildId] : undefined));
  return useMemo(() => {
    const ids = Object.keys(members);
    return { total: memberCount ?? ids.length, online: ids.filter(id => { const st = presences[id]?.status; return st && st !== 'offline' && st !== 'invisible'; }).length };
  }, [members, presences, memberCount]);
}

/** The per-server avatar hash of a loaded guild member (null when the user has none or the member is not loaded). */
export function useMemberAvatar(guildId: Snowflake | null | undefined, userId: Snowflake): string | null {
  return useStore(s => (guildId ? s.members[guildId]?.[userId]?.avatar ?? null : null));
}

/** Guilds where `userId` is a loaded member (client-side fallback when GET /users/{id}/profile is unavailable). */
export function useMutualGuildsFromStore(userId: Snowflake | null | undefined): Guild[] {
  return useStore(s => (userId ? s.guildOrder.filter(id => s.members[id]?.[userId]).map(id => s.guilds[id]!).filter(Boolean) : []));
}

/** Message display density (Settings > Appearance). `ChatProvider` reads this once and exposes it as `useChat().compact`. */
export function useCompactMode(): boolean { return usePrefs(s => s.messageDisplay === 'compact'); }

/** The shell's message display toggles that change what chat renders (one selector each: a fresh object would loop the store hook). */
export interface ChatDisplayPrefs {
  showEmbeds: boolean;
  showReactions: boolean;
  /** Compact layout only: a small avatar in front of the name. */
  showCompactAvatars: boolean;
  roleColors: 'name' | 'dot' | 'none';
  /** Streamer mode with "hide invite links" on: invite cards and invite links are not rendered. */
  hideInvites: boolean;
}
export function useChatDisplayPrefs(): ChatDisplayPrefs {
  return {
    showEmbeds: usePrefs(s => s.showEmbeds),
    showReactions: usePrefs(s => s.showReactions),
    showCompactAvatars: usePrefs(s => s.showCompactAvatars),
    roleColors: usePrefs(s => s.roleColors),
    hideInvites: usePrefs(s => s.streamerMode && s.streamerHideInvites),
  };
}

/** Settings > Appearance > "Convert emoticons to emoji": applied to the text of a message when it is sent. */
export function useConvertEmoticons(): boolean { return usePrefs(s => s.convertEmoticons); }

/** Channels of a guild, in position order (for #channel autocomplete and mention rendering). */
export function useGuildChannels(guildId: Snowflake | null | undefined): Channel[] {
  const all = useStore(s => s.channels);
  return useMemo(() => (guildId ? Object.values(all).filter(c => c.guild_id === guildId).sort((a, b) => a.position - b.position) : []), [all, guildId]);
}

/** Client-only "mark unread": move this client's read pointer of a channel back (the server keeps its own until the next ack). */
export function setLocalReadPointer(channelId: Snowflake, lastMessageId: Snowflake): void {
  const s = appStore.getState();
  appStore.setState({ readStates: { ...s.readStates, [channelId]: { channel_id: channelId, last_message_id: lastMessageId, mention_count: 0 } } });
}
