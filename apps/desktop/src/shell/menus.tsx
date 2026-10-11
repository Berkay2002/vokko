// Context-menu and dropdown contents, ordered like Discord's menus (research/discord-ui-inventory.md Part A).
// Entries the backend has no data for are present but disabled with a "Not available yet" tooltip.

import type { ReactNode } from "react";
import { Bell, CalendarPlus, CirclePlus, Copy, FolderPlus, Link2, LayoutGrid, LogOut, Pencil, Settings, ShieldCheck, UserPlus } from "lucide-react";
import { appStore, displayName, guildUnread, isChannelUnread } from "../api/store";
import { request } from "../api/rest";
import { Perm, basePermissions, canEditRole, canModerate, channelPermissions, hasBit, memberLike } from "../api/permissions";
import { ChannelType, RelationshipType, type Channel, type Guild, type Snowflake, type User } from "../api/types";
import type { MenuItem } from "../ui";
import { openCreateEvent } from "../community/communityModals";
import { closeDirectMessage, copyText, markChannelRead, markGuildRead, openDirectMessage } from "./actions";
import { isMutedAt, muteFor, MUTE_DURATIONS, mutedUntilText, NOTIFY_LABELS, setNotifyLevel, toggleFlag, unmute, useLocalState, type NotifyLevel } from "./localState";
import { openModal } from "./modalStore";
import { go, guildPath } from "./nav";
import { openProfile } from "./ProfileCard";
import { userAppsItems } from "../apps/menus";
import { serverSettingsSections } from "./ServerSettings";
import { voiceModerationItems, voiceUserMenuItems } from "../voice/voiceMenus";
import { getVoice } from "../voice/store";
import { useVoiceUi } from "../voice/uiStore";
import { getPrefs } from "../ui/prefs";

/** Settings > Advanced > Developer Mode adds the "Copy … ID" items. */
const devOnly = (items: MenuItem[]): MenuItem[] => (getPrefs().developerMode ? items : []);

export const UNAVAILABLE = "Not available yet";

const copy = (text: string) => () => copyText(text);
const sep: MenuItem = { type: "separator" };
const local = () => useLocalState.getState();
const unavailable = (id: string, label: string, icon?: ReactNode): MenuItem => ({ id, label, icon, disabled: true, tooltip: UNAVAILABLE });

/** Groups separated by separators; empty groups are dropped. */
function groups(...lists: MenuItem[][]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const list of lists) {
    if (list.length === 0) continue;
    if (out.length > 0) out.push(sep);
    out.push(...list);
  }
  return out;
}

const isOwnerOf = (guild: Guild) => appStore.getState().me?.id === guild.owner_id;

/** The viewer's permissions, computed when a menu opens (menu builders are plain functions). Channel-level when a channel is given. */
function viewerPerms(guild: Guild, channel?: Channel) {
  const state = appStore.getState();
  const meId = state.me?.id ?? "";
  const member = state.members[guild.id]?.[meId];
  const actor = { id: meId, roles: member?.roles ?? [], communication_disabled_until: member?.communication_disabled_until };
  const bits = channel ? channelPermissions(guild, actor, channel) : basePermissions(guild, actor);
  return { actor, bits, can: (permission: bigint) => hasBit(bits, permission) };
}

/** Q4.6: the server settings entry shows for any of these. */
const SETTINGS_ACCESS = [Perm.MANAGE_GUILD, Perm.MANAGE_ROLES, Perm.ADMINISTRATOR, Perm.BAN_MEMBERS, Perm.MANAGE_NICKNAMES];
const canOpenSettings = (can: (permission: bigint) => boolean) => SETTINGS_ACCESS.some(p => can(p));

// ---- mute + notification submenus (A1, A9) ----

/** "Mute <label>" submenu of durations, or "Unmute <label>" while muted. */
export function muteItem(id: Snowflake, label: string): MenuItem {
  if (isMutedAt(local(), id)) {
    const remaining = mutedUntilText(id);
    return { id: "unmute", label: `Unmute ${label}`, hint: remaining ?? undefined, onSelect: () => unmute(id) };
  }
  return { id: "mute", label: `Mute ${label}`, children: MUTE_DURATIONS.map(d => ({ id: d.id, label: d.label, onSelect: () => muteFor(id, d.ms) })) };
}

export function notificationItem(id: Snowflake, opts: { guild?: boolean; defaultLabel?: string } = {}): MenuItem {
  const current: NotifyLevel = local().notify[id] ?? "default";
  const radio = (level: Exclude<NotifyLevel, "default">): MenuItem => ({ id: level, label: NOTIFY_LABELS[level], checked: current === level, onSelect: () => setNotifyLevel(id, level) });
  const children: MenuItem[] = [];
  if (!opts.guild) children.push({ id: "default", label: opts.defaultLabel ?? "Use Server Default", checked: current === "default", onSelect: () => setNotifyLevel(id, "default") });
  children.push(radio("all"), radio("unreads-mentions"), radio("mentions"), radio("none"));
  if (opts.guild) {
    children.push(
      sep,
      { id: "suppress-everyone", label: "Suppress @everyone and @here", checked: !!local().suppressEveryone[id], onSelect: () => toggleFlag("suppressEveryone", id) },
      { id: "suppress-roles", label: "Suppress All Role @mentions", checked: !!local().suppressRoles[id], onSelect: () => toggleFlag("suppressRoles", id) },
      unavailable("suppress-highlights", "Suppress Highlights"),
      unavailable("mute-events", "Mute New Events"),
    );
  }
  return { id: "notifications", label: "Notification Settings", children };
}

const hideMutedItem = (guild: Guild): MenuItem => ({ id: "hide-muted", label: "Hide Muted Channels", checked: !!local().hideMuted[guild.id], onSelect: () => toggleFlag("hideMuted", guild.id) });

function firstTextChannelId(guildId: Snowflake): Snowflake | undefined {
  const channels = Object.values(appStore.getState().channels).filter(c => c.guild_id === guildId && c.type === ChannelType.GuildText);
  return channels.sort((a, b) => a.position - b.position)[0]?.id;
}

// ---- server (A4 rail context menu, A5 header dropdown) ----

export function guildContextItems(guild: Guild): MenuItem[] {
  const owner = isOwnerOf(guild);
  const { can } = viewerPerms(guild);
  const unread = guildUnread(appStore.getState(), guild.id).unread;
  const invite = firstTextChannelId(guild.id);
  return groups(
    [{ id: "mark-read", label: "Mark As Read", disabled: !unread, onSelect: () => void markGuildRead(guild.id) }],
    can(Perm.CREATE_INSTANT_INVITE) ? [{ id: "invite", label: "Invite to Server", disabled: !invite, onSelect: () => invite && openModal({ type: "invite", channelId: invite }) }] : [],
    [muteItem(guild.id, "Server"), notificationItem(guild.id, { guild: true }), hideMutedItem(guild)],
    [
      ...(canOpenSettings(can)
        ? [
            {
              id: "settings",
              label: "Server Settings",
              children: serverSettingsSections(can).map(section => ({ id: `settings-${section.id}`, label: section.label, onSelect: () => openModal({ type: "serverSettings", guildId: guild.id, section: section.id }) })),
            } satisfies MenuItem,
          ]
        : []),
      unavailable("privacy", "Privacy Settings"),
      unavailable("per-server-profile", "Edit Per-server Profile"),
    ],
    can(Perm.MANAGE_CHANNELS)
      ? [
          { id: "create-channel", label: "Create Channel", onSelect: () => openModal({ type: "createChannel", guildId: guild.id }) },
          { id: "create-category", label: "Create Category", onSelect: () => openModal({ type: "createChannel", guildId: guild.id, channelType: ChannelType.GuildCategory }) },
        ]
      : [],
    can(Perm.CREATE_EVENTS) || can(Perm.MANAGE_EVENTS) ? [{ id: "create-event", label: "Create Event", onSelect: () => openCreateEvent(guild.id) }] : [],
    owner ? [] : [{ id: "leave", label: "Leave Server", danger: true, onSelect: () => openModal({ type: "leaveServer", guildId: guild.id }) }],
    devOnly([{ id: "copy-id", label: "Copy Server ID", onSelect: copy(guild.id) }]),
  );
}

const DROPDOWN_ICONS: Record<string, ReactNode> = {
  invite: <UserPlus size={20} />,
  settings: <Settings size={20} />,
  "create-channel": <CirclePlus size={20} />,
  "create-category": <FolderPlus size={20} />,
  "create-event": <CalendarPlus size={20} />,
  "app-directory": <LayoutGrid size={20} />,
  "linked-roles": <Link2 size={20} />,
  notifications: <Bell size={20} />,
  privacy: <ShieldCheck size={20} />,
  "per-server-profile": <Pencil size={20} />,
  leave: <LogOut size={20} />,
  "copy-id": <Copy size={20} />,
};

export function guildDropdownItems(guild: Guild): MenuItem[] {
  return withIcons(guildDropdownItemsPlain(guild), DROPDOWN_ICONS);
}

function withIcons(items: MenuItem[], icons: Record<string, ReactNode>): MenuItem[] {
  return items.map(item => ("type" in item ? item : { ...item, icon: icons[item.id] ?? item.icon }));
}

function guildDropdownItemsPlain(guild: Guild): MenuItem[] {
  const owner = isOwnerOf(guild);
  const { can } = viewerPerms(guild);
  const invite = firstTextChannelId(guild.id);
  return groups(
    [
      ...(can(Perm.CREATE_INSTANT_INVITE) ? [{ id: "invite", label: "Invite to Server", disabled: !invite, onSelect: () => invite && openModal({ type: "invite", channelId: invite }) } satisfies MenuItem] : []),
      ...(canOpenSettings(can) ? [{ id: "settings", label: "Server Settings", onSelect: () => openModal({ type: "serverSettings", guildId: guild.id }) } satisfies MenuItem] : []),
      ...(can(Perm.MANAGE_CHANNELS)
        ? [
            { id: "create-channel", label: "Create Channel", onSelect: () => openModal({ type: "createChannel", guildId: guild.id }) } satisfies MenuItem,
            { id: "create-category", label: "Create Category", onSelect: () => openModal({ type: "createChannel", guildId: guild.id, channelType: ChannelType.GuildCategory }) } satisfies MenuItem,
          ]
        : []),
      ...(can(Perm.CREATE_EVENTS) || can(Perm.MANAGE_EVENTS) ? [{ id: "create-event", label: "Create Event", onSelect: () => openCreateEvent(guild.id) } satisfies MenuItem] : []),
      unavailable("app-directory", "App Directory"),
      unavailable("linked-roles", "Linked Roles"),
    ],
    [
      { id: "notifications", label: "Notification Settings", onSelect: () => openModal({ type: "notificationSettings", scopeId: guild.id, title: guild.name, guild: true }) },
      unavailable("privacy", "Privacy Settings"),
    ],
    [unavailable("per-server-profile", "Edit Per-server Profile"), hideMutedItem(guild)],
    owner ? [] : [{ id: "leave", label: "Leave Server", danger: true, onSelect: () => openModal({ type: "leaveServer", guildId: guild.id }) }],
    devOnly([{ id: "copy-id", label: "Copy Server ID", onSelect: copy(guild.id) }]),
  );
}

// ---- channels (A6) ----

export interface ChannelMenuOptions {
  /** Category rows: collapse state lives in the sidebar. */
  collapsed?: boolean;
  onToggleCollapse?(): void;
  onCollapseAll?(): void;
  anyExpanded?: boolean;
}

export function channelContextItems(channel: Channel, guild: Guild, options: ChannelMenuOptions = {}): MenuItem[] {
  const { can } = viewerPerms(guild, channel);
  const state = appStore.getState();
  const category = channel.type === ChannelType.GuildCategory;
  const voice = channel.type === ChannelType.GuildVoice;
  const children = Object.values(state.channels).filter(c => c.parent_id === channel.id);
  const unread = category ? children.some(c => isChannelUnread(state, c.id)) : isChannelUnread(state, channel.id);
  const markRead = () => (category ? Promise.all(children.map(c => markChannelRead(c.id))) : markChannelRead(channel.id));
  const label = category ? "Category" : "Channel";

  const manage: MenuItem[] = can(Perm.MANAGE_CHANNELS)
    ? [
        { id: "edit", label: `Edit ${label}`, onSelect: () => openModal({ type: "editChannel", channelId: channel.id }) },
        ...(category ? [] : [{ id: "duplicate", label: "Duplicate Channel", onSelect: () => void duplicateChannel(channel) } satisfies MenuItem]),
        ...(voice ? [] : [{ id: "create-text", label: category ? "Create Channel" : "Create Text Channel", onSelect: () => openModal({ type: "createChannel", guildId: guild.id, parentId: category ? channel.id : channel.parent_id }) } satisfies MenuItem]),
        ...(category ? [] : [{ id: "create-voice", label: "Create Voice Channel", onSelect: () => openModal({ type: "createChannel", guildId: guild.id, parentId: channel.parent_id, channelType: ChannelType.GuildVoice }) } satisfies MenuItem]),
        { id: "delete", label: `Delete ${label}`, danger: true, onSelect: () => openModal({ type: "deleteChannel", channelId: channel.id }) },
      ]
    : can(Perm.MANAGE_ROLES)
      ? [{ id: "edit-permissions", label: `Edit ${label} Permissions`, onSelect: () => openModal({ type: "channelSettings", channelId: channel.id, section: "permissions" }) }]
      : [];

  const invite = firstTextChannelId(guild.id);
  const link = `${window.location.origin}${guildPath(guild.id, channel.id)}`;
  return groups(
    [{ id: "mark-read", label: "Mark As Read", disabled: !unread, onSelect: () => void markRead() }],
    category
      ? [
          { id: "collapse", label: "Collapse Category", checked: !!options.collapsed, onSelect: options.onToggleCollapse },
          { id: "collapse-all", label: "Collapse All Categories", disabled: !options.anyExpanded, onSelect: options.onCollapseAll },
        ]
      : [
          ...(can(Perm.CREATE_INSTANT_INVITE) ? [{ id: "invite", label: voice ? "Invite to Voice" : "Invite People", disabled: !invite, onSelect: () => openModal({ type: "invite", channelId: channel.id }) } satisfies MenuItem] : []),
          { id: "copy-link", label: "Copy Link", onSelect: copy(link) },
        ],
    voice
      ? [
          {
            id: "open-chat",
            label: "Open Chat",
            onSelect: () => {
              useVoiceUi.getState().setChatOpen(true);
              go(guildPath(guild.id, channel.id));
            },
          },
        ]
      : [],
    [muteItem(channel.id, category ? "Category" : "Channel"), ...(voice ? [] : [notificationItem(channel.id, { defaultLabel: category ? "Use Server Default" : "Use Category Default" })])],
    manage,
    devOnly([{ id: "copy-id", label: `Copy ${label} ID`, onSelect: copy(channel.id) }]),
  );
}

async function duplicateChannel(channel: Channel): Promise<void> {
  if (!channel.guild_id || !channel.name) return;
  const created = await request<Channel>("POST", `/guilds/${channel.guild_id}/channels`, {
    name: channel.name,
    type: channel.type,
    ...(channel.parent_id ? { parent_id: channel.parent_id } : {}),
    ...(channel.topic ? { topic: channel.topic } : {}),
  });
  if (created.type === ChannelType.GuildText) go(guildPath(channel.guild_id, created.id));
}

// ---- DMs and users (A3) ----

export const blockUser = (userId: Snowflake): Promise<void> => request<void>("PUT", `/users/@me/relationships/${userId}`, { type: RelationshipType.Blocked });

function relationshipItems(user: User): MenuItem[] {
  const state = appStore.getState();
  const type = state.relationships[user.id]?.type;
  const items: MenuItem[] = [];
  if (type === RelationshipType.Friend) {
    items.push({ id: "remove-friend", label: "Remove Friend", onSelect: () => openModal({ type: "removeFriend", userId: user.id }) });
  } else if (type === RelationshipType.OutgoingRequest) {
    items.push({ id: "request-sent", label: "Friend Request Sent", disabled: true });
  } else if (type !== RelationshipType.Blocked) {
    items.push({ id: "add-friend", label: "Add Friend", onSelect: () => void request("PUT", `/users/@me/relationships/${user.id}`, {}) });
  }
  if (type === RelationshipType.Blocked) items.push({ id: "unblock", label: "Unblock", onSelect: () => void request("DELETE", `/users/@me/relationships/${user.id}`) });
  else items.push({ id: "block", label: "Block", danger: true, onSelect: () => void blockUser(user.id) });
  return items;
}

export interface UserMenuOptions {
  guildId?: Snowflake | null;
  anchor?: HTMLElement | null;
  /** Called by "Mention" with the user; the chat composer can hook this later. */
  onMention?(user: User): void;
}

export function userContextItems(user: User, options: UserMenuOptions = {}): MenuItem[] {
  const state = appStore.getState();
  const isMe = state.me?.id === user.id;
  const guild = options.guildId ? state.guilds[options.guildId] : undefined;
  const member = options.guildId ? state.members[options.guildId]?.[user.id] : undefined;
  const roles = guild && member ? guild.roles.filter(r => member.roles.includes(r.id) && r.id !== guild.id).sort((a, b) => b.position - a.position) : [];
  const name = displayName(user, member);
  const anchor = options.anchor;

  // Moderation rights, hidden (not disabled) when the viewer lacks them.
  const viewer = guild ? viewerPerms(guild).actor : undefined;
  const allowed = (action: "kick" | "ban" | "timeout" | "nickname" | "roles") => !!guild && !!member && !!viewer && canModerate(guild, viewer, memberLike(member), action);
  const mayNick = allowed("nickname");
  const mayRoles = !isMe && allowed("roles");
  const mayTimeout = !isMe && allowed("timeout") && !hasBit(basePermissions(guild!, memberLike(member!)), Perm.ADMINISTRATOR);
  const mayKick = !isMe && allowed("kick");
  const mayBan = !isMe && allowed("ban");
  const target = { guildId: options.guildId ?? "", userId: user.id };
  const timedOut = !!member?.communication_disabled_until && Date.parse(member.communication_disabled_until) > Date.now();
  const assignable = mayRoles && guild && viewer ? guild.roles.filter(r => r.id !== guild.id && canEditRole(guild, viewer, r)).sort((a, b) => b.position - a.position) : [];
  const toggleRole = (roleId: Snowflake) => {
    if (!member || !guild) return;
    const current = member.roles.filter(id => id !== guild.id);
    const next = current.includes(roleId) ? current.filter(id => id !== roleId) : [...current, roleId];
    void request("PATCH", `/guilds/${guild.id}/members/${user.id}`, { roles: next });
  };
  const moderation: MenuItem[] = [
    ...(mayTimeout
      ? [
          timedOut
            ? ({ id: "timeout", label: "Remove Timeout", onSelect: () => void request("PATCH", `/guilds/${target.guildId}/members/${user.id}`, { communication_disabled_until: null }) } satisfies MenuItem)
            : ({ id: "timeout", label: `Timeout ${name}`, onSelect: () => openModal({ type: "timeoutMember", ...target }) } satisfies MenuItem),
        ]
      : []),
    ...(mayKick ? [{ id: "kick", label: `Kick ${name}`, danger: true, onSelect: () => openModal({ type: "kickMember", ...target }) } satisfies MenuItem] : []),
    ...(mayBan ? [{ id: "ban", label: `Ban ${name}`, danger: true, onSelect: () => openModal({ type: "banMember", ...target }) } satisfies MenuItem] : []),
  ];

  // Moderators see the voice switches (Server Mute / Deafen, Move To, Disconnect, stage speaker controls) for people in voice here.
  const serverVoice: MenuItem[] = guild ? voiceModerationItems(user.id, guild.id) : [];

  return groups(
    [
      { id: "profile", label: "Profile", disabled: !anchor, onSelect: () => anchor && openProfile(anchor, user.id, options.guildId ?? null) },
      options.onMention ? { id: "mention", label: "Mention", onSelect: () => options.onMention?.(user) } : unavailable("mention", "Mention"),
      ...(isMe ? [] : [{ id: "message", label: "Message", onSelect: () => void openDirectMessage(user.id) } satisfies MenuItem, unavailable("call", "Start a Call")]),
    ],
    voiceUserMenuItems(user.id),
    isMe
      ? [unavailable("per-server-profile", "Edit Per-server Profile"), ...(mayNick ? [{ id: "change-nickname", label: "Change Nickname", onSelect: () => openModal({ type: "nickname", ...target }) } satisfies MenuItem] : [])]
      : [
          unavailable("invite-to-server", "Invite to Server"),
          ...relationshipItems(user),
          ...(mayNick ? [{ id: "change-nickname", label: "Change Nickname", onSelect: () => openModal({ type: "nickname", ...target }) } satisfies MenuItem] : []),
        ],
    guild && mayRoles && assignable.length > 0
      ? [
          {
            id: "roles",
            label: "Roles",
            children: assignable.map(r => ({
              id: r.id,
              label: r.name,
              checked: !!member?.roles.includes(r.id),
              icon: <span className="role-dot" style={{ background: r.color ? `#${r.color.toString(16).padStart(6, "0")}` : "var(--text-muted)" }} />,
              onSelect: () => toggleRole(r.id),
            })),
          },
        ]
      : guild && roles.length > 0
        ? [{ id: "roles", label: `${roles.length} ${roles.length === 1 ? "Role" : "Roles"}`, children: roles.map(r => ({ id: r.id, label: r.name, disabled: true })) }]
        : [],
    moderation,
    userAppsItems(user),
    serverVoice,
    devOnly([{ id: "copy-id", label: "Copy User ID", onSelect: copy(user.id) }]),
  );
}

export function dmContextItems(channel: Channel, options: { anchor?: HTMLElement | null } = {}): MenuItem[] {
  const state = appStore.getState();
  const group = channel.type === ChannelType.GroupDM;
  const other = group ? undefined : channel.recipients?.[0];
  const unread = isChannelUnread(state, channel.id);
  const name = other ? displayName(other) : (channel.name ?? "Conversation");
  return groups(
    [{ id: "mark-read", label: "Mark As Read", disabled: !unread, onSelect: () => void markChannelRead(channel.id) }],
    [{ id: "close", label: group ? "Leave Group" : "Close DM", danger: group, onSelect: () => void closeDirectMessage(channel.id) }],
    other
      ? [
          { id: "profile", label: "Profile", disabled: !options.anchor, onSelect: () => options.anchor && openProfile(options.anchor, other.id, null) },
          unavailable("call", "Start a Call"),
        ]
      : [],
    other ? relationshipItems(other) : [],
    [muteItem(channel.id, group ? "Conversation" : name)],
    devOnly([...(other ? [{ id: "copy-user-id", label: "Copy User ID", onSelect: copy(other.id) } satisfies MenuItem] : []), { id: "copy-id", label: "Copy Channel ID", onSelect: copy(channel.id) }]),
  );
}
