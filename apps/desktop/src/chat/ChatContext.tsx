import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Attachment, Channel, Guild, GuildMember, Message, Role, Snowflake, User } from '../api/types';
import { ChannelType } from '../api/types';
import type { MarkdownContext } from './markdown';
import { AnimatedImage, cacheUser, closeModal, displayName, go, guildPath, openProfile, roleColor, useStableChannel, useChatDisplayPrefs, useCompactMode, useCustomColorScale, useGuild, useGuildChannels, useGuildMembers, useMe, useUsers, type ChatDisplayPrefs } from './shell';
import { mentionTarget } from './mentions';
import { cachedUser } from './userCache';
import { useEmojiDb } from './emojiData';
import { EmojiGlyph } from './EmojiInfo';

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
  /** Role colour of an author in this channel, null when they have none, this is a DM, or the role-colour setting is not "name". */
  colorOf(message: Message): string | null;
  /** Role colour for the dot in front of the name; only set when the role-colour setting is "dot". */
  roleDotOf(message: Message): string | null;
  /** The shell's message display toggles (embeds, reactions, role colours, compact avatars). */
  display: ChatDisplayPrefs;
  userById(id: Snowflake): User | undefined;
  /** Hooks supplied by ChatView. */
  actions: ChatActions;
  /** Message the composer is currently replying to; its row gets the "replying" highlight. */
  replyingId: Snowflake | null;
  /** Compact message display (the shell's appearance setting). */
  compact: boolean;
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
  /** Pencil on a sent image: the "Modify Attachment" dialog (read-only, the contract can't change sent attachments). */
  viewAttachment(message: Message, attachment: Attachment): void;
  /** Trash on a sent image: asks, then removes the attachment from the message. */
  deleteAttachment(message: Message, attachment: Attachment): void;
  viewReactions(m: Message): void;
}

const Ctx = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useChat outside <ChatProvider>');
  return v;
}

/**
 * `onNavigate` runs after a mention click moved the app to another channel, so a surface that floats over the chat (the pins popout)
 * can close itself; open dialogs are closed by the handler.
 */
export function ChatProvider({ channelId, actions, replyingId = null, onNavigate, children }: { channelId: Snowflake; actions: ChatActions; replyingId?: Snowflake | null; onNavigate?: () => void; children: ReactNode }) {
  const me = useMe();
  const channel = useStableChannel(channelId);
  const guildId = channel?.guild_id ?? null;
  const guild = useGuild(guildId);
  const members = useGuildMembers(guildId);
  const users = useUsers();
  const guildChannels = useGuildChannels(guildId);
  const emoji = useEmojiDb();
  const shortcodes = emoji?.shortcodes;
  const compact = useCompactMode();
  const { showEmbeds, showReactions, showCompactAvatars, roleColors, hideInvites, timeFormat } = useChatDisplayPrefs();
  const scaleColor = useCustomColorScale();

  const value = useMemo<ChatContextValue | null>(() => {
    if (!me) return null;
    const recipients = channel?.recipients ?? [];
    const userById = (id: Snowflake): User | undefined => (id === me.id ? me : users[id] ?? members[id]?.user ?? recipients.find(u => u.id === id) ?? cachedUser(id));
    const nameOf = (user: User, member?: Pick<GuildMember, 'nick'> | null): string => displayName(user, guildId ? member ?? members[user.id] : null);
    const roles = guild?.roles ?? [];
    const mentionEnv = { guildId, channels: guildChannels, hasUser: (uid: Snowflake) => !!userById(uid) };
    const md: MarkdownContext = {
      userName: id => { const u = userById(id); return u ? nameOf(u, members[id]) : null; },
      roleInfo: id => {
        const r = roles.find(x => x.id === id);
        return r ? { name: r.name, color: r.color ? scaleColor(`#${r.color.toString(16).padStart(6, '0')}`) : null } : null;
      },
      channelName: id => guildChannels.find(c => c.id === id)?.name ?? null,
      currentUserId: me.id,
      emojiShortcodes: shortcodes,
      onLink: actions.openLink,
      mentionActionable: (kind, mentionId) => mentionTarget(kind, mentionId, mentionEnv) !== null,
      onMention: (kind, mentionId, ev) => {
        const target = mentionTarget(kind, mentionId, mentionEnv);
        if (!target) return;
        if (target.type === 'profile') {
          // The profile card reads the store; a user known only from a member list, a recipient or the message cache must be in it.
          const user = userById(target.userId);
          if (user) cacheUser(user);
          openProfile(ev.currentTarget as HTMLElement, target.userId, target.guildId);
          return;
        }
        if (!guildId) return;
        closeModal();
        go(guildPath(guildId, target.channel.id));
        onNavigate?.();
      },
      renderEmoji: (unicode, name) => <EmojiGlyph unicode={unicode} name={name} />,
      renderCustomEmoji: ({ src, name, animated }) => animated
        ? <AnimatedImage kind="emoji" className="md-emoji md-emoji-custom" src={src} alt={`:${name}:`} title={`:${name}:`} draggable={false} loading="lazy" />
        : <img className="md-emoji md-emoji-custom" src={src} alt={`:${name}:`} title={`:${name}:`} draggable={false} loading="lazy" />,
    };
    return {
      channelId, channel, guild, guildId, me, md, roles, members, channels: guildChannels, actions, userById, nameOf, replyingId, compact,
      isDm: channel?.type === ChannelType.DM || channel?.type === ChannelType.GroupDM,
      canManage: canManageMessages(guild, me, members[me.id]),
      colorOf: m => (guildId && roleColors === 'name' ? scaleColor(roleColor(guildId, members[m.author.id] ?? m.member ?? null)) : null),
      roleDotOf: m => (guildId && roleColors === 'dot' ? scaleColor(roleColor(guildId, members[m.author.id] ?? m.member ?? null)) : null),
      display: { showEmbeds, showReactions, showCompactAvatars, roleColors, hideInvites, timeFormat },
    };
  }, [me, channel, channelId, guild, guildId, members, users, guildChannels, shortcodes, actions, onNavigate, replyingId, compact, showEmbeds, showReactions, showCompactAvatars, roleColors, hideInvites, timeFormat, scaleColor]);

  if (!value) return null;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
