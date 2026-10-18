// The only module in src/chat that imports shell-owned code (src/api, src/ui). Everything else in the chat area goes through here,
// so contract drift between the shell and the chat area is fixed in one file.
import { useMemo, useRef } from 'react';
import { appStore, useStore } from '../api/store';
import { usePrefs } from '../ui';
import { getPrefs, localeTag } from '../ui/prefs';
import type { Channel, Guild, GuildMember, ReadState, Relationship, Snowflake, User } from '../api/types';

export { request, uploadAttachment, resolveUrl, ApiRequestError } from '../api/rest';
export { gateway } from '../api/gateway';
export { displayName, roleColor, roleIcon, avatarUrl, dmName, guildIconUrl, guildInitials } from '../api/store';
export { markGuildRead, joinGuildWithInvite, joinOrApply, copyText } from '../shell/actions';
export { go, guildPath, messageLink, messagePathOf } from '../shell/nav';
export { openModal, closeModal } from '../shell/modalStore';
export { openProfile } from '../shell/profileStore';
/** The user context menu's items, loaded on use: a static import of shell/menus from the chat area loops back into it. */
export const loadUserMenu = () => import('../shell/menus').then(m => m.userContextItems);
export { usePermissions } from '../shell/usePermissions';
export { Perm, canSendIn } from '../api/permissions';
export { Tooltip, Popout, Modal, BottomSheet, usePhone, useContextMenu, useLayer, useOutsideClose, placeAtPoint } from '../ui';
export { AnimatedImage, AnimatedVideo } from '../ui/AnimatedMedia';
export type { MenuItem } from '../ui';

const NO_MEMBERS: Record<Snowflake, GuildMember> = {};

/** Puts a user into the shared store (the profile card only opens for users the store holds). */
export function cacheUser(user: User): void { appStore.getState().cacheUsers([user]); }

/** The signed-in user's id (null before the session is ready and after sign-out), and a listener for it changing. */
export function currentUserId(): string | null { return appStore.getState().me?.id ?? null; }
export function onUserChange(cb: (id: string | null) => void): void { appStore.subscribe((s, prev) => { if (s.me?.id !== prev.me?.id) cb(s.me?.id ?? null); }); }

export function useMe(): User | null { return useStore(s => s.me); }

/** Whether others may see `myId` typing: not while invisible, nor with "Show when I'm typing" (or Share my activity) off. */
export function sharesTyping(myId: Snowflake): boolean {
  const prefs = getPrefs();
  return appStore.getState().presences[myId]?.status !== 'invisible' && prefs.shareActivity && prefs.shareTyping;
}
/** The startup cache is on screen and the gateway is not ready yet: nothing can be sent. */
export function useStale(): boolean { return useStore(s => s.stale); }
export function useChannel(channelId: Snowflake): Channel | undefined { return useStore(s => s.channels[channelId] ?? s.threads[channelId]); }

/** Fields that move with every message; a change in only these does not make a channel "different" for rendering. */
const COUNTERS = new Set<string>(['last_message_id', 'message_count']);
function sameApartFromCounters(a: Channel, b: Channel): boolean {
  const ka = Object.keys(a) as (keyof Channel)[];
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every(k => COUNTERS.has(k) || a[k] === b[k]);
}

/**
 * `useChannel` for the chat context: keeps the previous object while only the counters changed, so every visible message row does not
 * re-render when a message arrives. Callers must not read `last_message_id` / `message_count` from it.
 */
export function useStableChannel(channelId: Snowflake): Channel | undefined {
  const channel = useChannel(channelId);
  const kept = useRef(channel);
  if (channel !== kept.current && !(channel && kept.current && sameApartFromCounters(channel, kept.current))) kept.current = channel;
  return kept.current;
}
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
  /** Settings > Chat: uploaded images/videos inline (off: file cards). */
  inlineAttachmentMedia: boolean;
  /** Settings > Chat: images/videos of link previews (off: text-only cards). */
  inlineEmbedMedia: boolean;
  /** Settings > Chat > spoilers: "click" (default), "moderated" (shown where I can manage messages), "always". */
  spoilerContent: 'click' | 'moderated' | 'always';
  /** Settings > Language & Time clock; part of the display prefs so timestamps re-render when it changes. */
  timeFormat: 'auto' | '12' | '24';
}
export function useChatDisplayPrefs(): ChatDisplayPrefs {
  return {
    showEmbeds: usePrefs(s => s.showEmbeds),
    showReactions: usePrefs(s => s.showReactions),
    showCompactAvatars: usePrefs(s => s.showCompactAvatars),
    roleColors: usePrefs(s => s.roleColors),
    hideInvites: usePrefs(s => s.streamerMode && s.streamerHideInvites),
    timeFormat: usePrefs(s => s.timeFormat),
    inlineAttachmentMedia: usePrefs(s => s.inlineAttachmentMedia),
    inlineEmbedMedia: usePrefs(s => s.inlineEmbedMedia),
    spoilerContent: usePrefs(s => s.spoilerContent),
  };
}

/** Settings > Accessibility > "Show image descriptions": alt text is also drawn under images and attachments that have it. */
export function useShowImageDescriptions(): boolean { return usePrefs(s => s.showImageDescriptions); }

/** Settings > Accessibility > "Use legacy chat input": a plain text box without live formatting or emoticon conversion (autocomplete stays). */
export function useLegacyChatInput(): boolean { return usePrefs(s => s.legacyChatInput); }

/** A custom (role) colour, scaled by Settings > Accessibility > Saturation when "apply to custom colours" is on. */
export { useCustomColor, useCustomColorScale } from '../ui/useCustomColor';

/** `smooth` unless Accessibility > Reduced Motion is in effect (CSS scroll-behavior does not reach explicit JS requests). */
export function scrollBehavior(): 'auto' | 'smooth' { return document.documentElement.classList.contains('reduce-motion') ? 'auto' : 'smooth'; }

/** Current clock choice outside React (formatTime in util.ts). */
export function timeFormatPref(): 'auto' | '12' | '24' { return usePrefs.getState().timeFormat; }

/** The document language (locale + clock choice, Settings > Language & Time); timestamps re-render when it changes. */
export function useChatLocale(): string { return usePrefs(s => localeTag(s)); }

/** Settings > Advanced > Developer Mode (menus add "Copy … ID"); read when a menu opens. */
export function isDeveloperMode(): boolean { return getPrefs().developerMode; }

/** Settings > Chat options the composer reads. */
export interface ComposerOptions {
  emojiAutocomplete: boolean;
  stickerSuggestions: boolean;
  stickerAutocomplete: boolean;
  previewMarkdown: boolean;
}
export function useComposerOptions(): ComposerOptions {
  return {
    emojiAutocomplete: usePrefs(s => s.emojiAutocomplete),
    stickerSuggestions: usePrefs(s => s.stickerSuggestions),
    stickerAutocomplete: usePrefs(s => s.stickerAutocomplete),
    previewMarkdown: usePrefs(s => s.previewMarkdown),
  };
}


/** Settings > Appearance > "Convert emoticons to emoji": applied to the text of a message when it is sent. */
export function useConvertEmoticons(): boolean { return usePrefs(s => s.convertEmoticons); }

/** Channels of a guild, in position order (for #channel autocomplete and mention rendering). */
/** The list keeps its identity while only message counters change (every new message in the guild), so consumers do not re-render. */
export function useGuildChannels(guildId: Snowflake | null | undefined): Channel[] {
  const all = useStore(s => s.channels);
  const list = useMemo(() => (guildId ? Object.values(all).filter(c => c.guild_id === guildId).sort((a, b) => a.position - b.position) : []), [all, guildId]);
  const kept = useRef(list);
  const prev = kept.current;
  if (list !== prev && !(list.length === prev.length && list.every((c, i) => c === prev[i] || sameApartFromCounters(c, prev[i]!)))) kept.current = list;
  return kept.current;
}

/** Client-only "mark unread": move this client's read pointer of a channel back (the server keeps its own until the next ack). */
export function setLocalReadPointer(channelId: Snowflake, lastMessageId: Snowflake): void {
  const s = appStore.getState();
  appStore.setState({ readStates: { ...s.readStates, [channelId]: { channel_id: channelId, last_message_id: lastMessageId, mention_count: 0 } } });
}
