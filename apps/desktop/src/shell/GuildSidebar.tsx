import { useMemo, useState } from "react";
import { NavLink, useLocation } from "react-router";
import { Bell, ChevronDown, ChevronRight, ChevronUp, CirclePlus, Copy, FolderPlus, Hash, LogOut, Plus, Settings, Trash2, UserPlus, Volume2 } from "lucide-react";
import { channelMentionCount, displayName, isChannelUnread, useStore } from "../api/store";
import { useVoiceOccupants } from "../api/voice";
import { ChannelType, type Channel, type Guild, type Snowflake } from "../api/types";
import { Popout, Tooltip, useContextMenu } from "../ui";
import { Avatar } from "./Avatar";
import { markChannelRead } from "./actions";
import { groupChannels } from "./channels";
import { guildPath } from "./nav";
import { openModal } from "./modalStore";

const COLLAPSED_KEY = "vokko.collapsedCategories";

function loadCollapsed(): Set<Snowflake> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as Snowflake[]);
  } catch {
    return new Set();
  }
}

function VoiceOccupants({ channelId, guildId }: { channelId: Snowflake; guildId: Snowflake }) {
  const occupants = useVoiceOccupants(channelId);
  const users = useStore(s => s.users);
  const members = useStore(s => s.members[guildId]);
  if (occupants.length === 0) return null;
  return (
    <ul className="voice-occupants">
      {occupants.map(id => {
        const user = users[id];
        if (!user) return null;
        return (
          <li key={id} className="voice-occupant">
            <Avatar user={user} size={24} />
            <span className="voice-occupant-name">{displayName(user, members?.[id])}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ChannelRow({ channel, guild }: { channel: Channel; guild: Guild }) {
  const location = useLocation();
  const unread = useStore(s => isChannelUnread(s, channel.id));
  const mentions = useStore(s => channelMentionCount(s, channel.id));
  const isOwner = useStore(s => s.me?.id === guild.owner_id);
  const menu = useContextMenu();
  const voice = channel.type === ChannelType.GuildVoice;
  const selected = location.pathname === `/channels/${guild.id}/${channel.id}`;
  const className = `channel-row${selected ? " selected" : ""}${unread ? " unread" : ""}${voice ? " voice" : ""}`;

  const items = [
    { id: "read", label: "Mark As Read", disabled: !unread, onSelect: () => void markChannelRead(channel.id) },
    { type: "separator" as const },
    { id: "invite", label: "Invite People", onSelect: () => openModal({ type: "invite", channelId: channel.id }) },
    { id: "copy", label: "Copy Channel ID", onSelect: () => void navigator.clipboard?.writeText(channel.id) },
    ...(isOwner ? [{ type: "separator" as const }, { id: "delete", label: "Delete Channel", danger: true, onSelect: () => openModal({ type: "deleteChannel", channelId: channel.id }) }] : []),
  ];

  const icon = voice ? <Volume2 size={20} className="channel-icon" /> : <Hash size={20} className="channel-icon" />;
  const actions = (
    <span className="channel-actions">
      <Tooltip content="Create Invite" side="top">
        <button type="button" className="channel-action" aria-label="Create Invite" onClick={e => (e.preventDefault(), openModal({ type: "invite", channelId: channel.id }))}>
          <UserPlus size={16} />
        </button>
      </Tooltip>
      <Tooltip content="Edit Channel" side="top">
        <button type="button" className="channel-action" aria-label="Edit Channel" onClick={e => e.preventDefault()}>
          <Settings size={16} />
        </button>
      </Tooltip>
    </span>
  );

  return (
    <li className="channel-row-wrap">
      {voice ? (
        <div className={className} role="button" tabIndex={0} aria-label={`${channel.name} voice channel`} onContextMenu={e => menu.open(e, items)}>
          {icon}
          <span className="channel-name">{channel.name}</span>
          {actions}
        </div>
      ) : (
        <NavLink to={guildPath(guild.id, channel.id)} className={className} onContextMenu={e => menu.open(e, items)}>
          {icon}
          <span className="channel-name">{channel.name}</span>
          {mentions > 0 ? <span className="count-badge">{mentions}</span> : null}
          {actions}
        </NavLink>
      )}
      {voice && <VoiceOccupants channelId={channel.id} guildId={guild.id} />}
    </li>
  );
}

function GuildHeader({ guild }: { guild: Guild }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const isOwner = useStore(s => s.me?.id === guild.owner_id);
  const firstText = useStore(s => Object.values(s.channels).find(c => c.guild_id === guild.id && c.type === ChannelType.GuildText));
  const invite = () => firstText && openModal({ type: "invite", channelId: firstText.id });
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <>
      <div ref={setAnchor} className={`guild-header${open ? " open" : ""}`}>
        <button type="button" className="guild-header-name-button" onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open}>
          <span className="guild-header-name">{guild.name}</span>
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        <Tooltip content="Invite People" side="bottom">
          <button type="button" className="guild-header-invite" aria-label="Invite People" disabled={!firstText} onClick={invite}>
            <UserPlus size={20} />
          </button>
        </Tooltip>
      </div>
      <Popout anchor={anchor} open={open} onClose={() => setOpen(false)} side="bottom" align="center" gap={4} className="guild-menu" style={{ width: 220 }}>
        <div role="menu" className="guild-menu-list">
          <button type="button" role="menuitem" className="guild-menu-item" disabled={!firstText} onClick={run(invite)}>
            <span>Invite People</span>
            <UserPlus size={20} />
          </button>
          <button type="button" role="menuitem" className="guild-menu-item" onClick={run(() => openModal({ type: "serverSettings", guildId: guild.id }))}>
            <span>Server Settings</span>
            <Settings size={20} />
          </button>
          <button type="button" role="menuitem" className="guild-menu-item" onClick={run(() => openModal({ type: "createChannel", guildId: guild.id }))}>
            <span>Create Channel</span>
            <CirclePlus size={20} />
          </button>
          <button type="button" role="menuitem" className="guild-menu-item" onClick={run(() => openModal({ type: "createChannel", guildId: guild.id, channelType: ChannelType.GuildCategory }))}>
            <span>Create Category</span>
            <FolderPlus size={20} />
          </button>
          <div className="guild-menu-separator" />
          <button type="button" role="menuitem" className="guild-menu-item" aria-disabled="true">
            <span>Notification Settings</span>
            <Bell size={20} />
          </button>
          <div className="guild-menu-separator" />
          <button type="button" role="menuitem" className="guild-menu-item" onClick={run(() => void navigator.clipboard?.writeText(guild.id))}>
            <span>Copy Server ID</span>
            <Copy size={20} />
          </button>
          <div className="guild-menu-separator" />
          <button type="button" role="menuitem" className="guild-menu-item danger" onClick={run(() => openModal({ type: isOwner ? "deleteServer" : "leaveServer", guildId: guild.id }))}>
            <span>{isOwner ? "Delete Server" : "Leave Server"}</span>
            {isOwner ? <Trash2 size={20} /> : <LogOut size={20} />}
          </button>
        </div>
      </Popout>
    </>
  );
}

export function GuildSidebar({ guild }: { guild: Guild }) {
  const location = useLocation();
  const channels = useStore(s => Object.values(s.channels).filter(c => c.guild_id === guild.id));
  const unreadIds = useStore(s => channels.filter(c => isChannelUnread(s, c.id)).map(c => c.id));
  const [collapsed, setCollapsed] = useState<Set<Snowflake>>(loadCollapsed);
  const groups = useMemo(() => groupChannels(channels), [channels]);
  const isOwner = useStore(s => s.me?.id === guild.owner_id);
  const selectedId = location.pathname.split("/")[3];

  const toggle = (id: Snowflake) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return (
    <div className="sidebar-list guild-sidebar">
      <GuildHeader guild={guild} />
      <div className="sidebar-scroller channel-scroller">
        <ul className="channel-list" aria-label="Channels">
          {groups.map(group => {
            const { category } = group;
            const isCollapsed = !!category && collapsed.has(category.id);
            const visible = isCollapsed ? group.channels.filter(c => c.id === selectedId || unreadIds.includes(c.id)) : group.channels;
            return (
              <li key={category?.id ?? "loose"} className="category">
                {category && (
                  <div className={`category-header${isCollapsed ? " collapsed" : ""}`}>
                    <button type="button" className="category-toggle" aria-expanded={!isCollapsed} onClick={() => toggle(category.id)}>
                      <span className="category-name">{category.name}</span>
                      {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    </button>
                    {isOwner && (
                      <Tooltip content="Create Channel" side="top">
                        <button type="button" className="category-add" aria-label="Create Channel" onClick={() => openModal({ type: "createChannel", guildId: guild.id, parentId: category.id })}>
                          <Plus size={16} />
                        </button>
                      </Tooltip>
                    )}
                  </div>
                )}
                <ul className="category-channels">
                  {visible.map(c => (
                    <ChannelRow key={c.id} channel={c} guild={guild} />
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
