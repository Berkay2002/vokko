import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Channel, Guild, GuildMember, Message, Role, Snowflake, User } from '../api/types';
import { ChannelType } from '../api/types';
import type { MarkdownContext } from './markdown';
import { displayName, roleColor, useChannel, useGuild, useGuildChannels, useGuildMembers, useMe, useUsers } from './shell';
import { cachedUser } from './userCache';
import { useEmojiDb } from './emojiData';

const ADMINISTRATOR = 1n << 3n;
const MANAGE_MESSAGES = 1n << 13n;

export function canManageMessages(guild: Guild | undefined, me: User | null, member: GuildMember | undefined): boolean {
  if (!guild || !me) return false;
  if (guild.owner_id === me.id) return true;
  let bits = 0n;
  for (const r of guild.roles) {
    if (r.id === guild.id || member?.roles.includes(r.id)) {
      try { bits |= BigInt(r.permissions); } catch { /* malformed bitfield */ }
    }
  }
  return (bits & ADMINISTRATOR) !== 0n || (bits & MANAGE_MESSAGES) !== 0n;
}

export interface ChatContextValue {
  channelId: Snowflake;
  channel: Channel | undefined;
  guild: Guild | undefined;
  guildId: Snowflake | null;
  me: User;
  isDm: boolean;
  canManage: boolean;
  md: MarkdownContext;
  roles: Role[];
  /** Channels of this guild (empty in DMs). */
  channels: Channel[];
  members: Record<Snowflake, GuildMember>;
  /** Display name for an author in this channel (nickname → display name → username). */
  nameOf(user: User, member?: Pick<GuildMember, 'nick'> | null): string;
  /** Role colour of an author in this channel, null when they have none or this is a DM. */
  colorOf(message: Message): string | null;
  userById(id: Snowflake): User | undefined;
  /** Hooks supplied by ChatView. */
  actions: ChatActions;
  /** Message the composer is currently replying to; its row gets the "replying" highlight. */
  replyingId: Snowflake | null;
}

export interface ChatActions {
  reply(m: Message): void;
  edit(m: Message): void;
  requestDelete(m: Message, skipConfirm: boolean): void;
  togglePin(m: Message): void;
  react(m: Message, emoji: { id: string | null; name: string }): void;
  jumpTo(messageId: Snowflake): void;
  openLink(href: string): void;
  openImage(message: Message, index: number): void;
}

const Ctx = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useChat outside <ChatProvider>');
  return v;
}

export function ChatProvider({ channelId, actions, replyingId = null, children }: { channelId: Snowflake; actions: ChatActions; replyingId?: Snowflake | null; children: ReactNode }) {
  const me = useMe();
  const channel = useChannel(channelId);
  const guildId = channel?.guild_id ?? null;
  const guild = useGuild(guildId);
  const members = useGuildMembers(guildId);
  const users = useUsers();
  const guildChannels = useGuildChannels(guildId);
  const emoji = useEmojiDb();
  const shortcodes = emoji?.shortcodes;

  const value = useMemo<ChatContextValue | null>(() => {
    if (!me) return null;
    const recipients = channel?.recipients ?? [];
    const userById = (id: Snowflake): User | undefined => (id === me.id ? me : users[id] ?? members[id]?.user ?? recipients.find(u => u.id === id) ?? cachedUser(id));
    const nameOf = (user: User, member?: Pick<GuildMember, 'nick'> | null): string => displayName(user, guildId ? member ?? members[user.id] : null);
    const roles = guild?.roles ?? [];
    const md: MarkdownContext = {
      userName: id => { const u = userById(id); return u ? nameOf(u, members[id]) : null; },
      roleInfo: id => {
        const r = roles.find(x => x.id === id);
        return r ? { name: r.name, color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null } : null;
      },
      channelName: id => guildChannels.find(c => c.id === id)?.name ?? null,
      currentUserId: me.id,
      emojiShortcodes: shortcodes,
      onLink: actions.openLink,
    };
    return {
      channelId, channel, guild, guildId, me, md, roles, members, channels: guildChannels, actions, userById, nameOf, replyingId,
      isDm: channel?.type === ChannelType.DM || channel?.type === ChannelType.GroupDM,
      canManage: canManageMessages(guild, me, members[me.id]),
      colorOf: m => (guildId ? roleColor(guildId, members[m.author.id] ?? m.member ?? null) : null),
    };
  }, [me, channel, channelId, guild, guildId, members, users, guildChannels, shortcodes, actions, replyingId]);

  if (!value) return null;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
