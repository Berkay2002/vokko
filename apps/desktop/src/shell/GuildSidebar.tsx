import { useMemo, useState } from "react";
import { NavLink, useLocation } from "react-router";
import { Check, ChevronDown, ChevronRight, ChevronUp, Hash, Plus, Settings, UserPlus, Volume2 } from "lucide-react";
import { channelMentionCount, displayName, isChannelUnread, useStore } from "../api/store";
import { useVoiceOccupants } from "../api/voice";
import { ChannelType, type Channel, type Guild, type Snowflake } from "../api/types";
import { Popout, Tooltip, useContextMenu } from "../ui";
import { Avatar } from "./Avatar";
import { groupChannels } from "./channels";
import { useIsMuted, useLocalState } from "./localState";
import { channelContextItems, guildDropdownItems } from "./menus";
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
  const muted = useIsMuted(channel.id) || useIsMuted(channel.parent_id);
  const menu = useContextMenu();
  const voice = channel.type === ChannelType.GuildVoice;
  const selected = location.pathname === `/channels/${guild.id}/${channel.id}`;
  const className = `channel-row${selected ? " selected" : ""}${unread && !muted ? " unread" : ""}${muted ? " muted" : ""}${voice ? " voice" : ""}`;
  const items = () => channelContextItems(channel, guild);

  const icon = voice ? <Volume2 size={20} className="channel-icon" /> : <Hash size={20} className="channel-icon" />;
  const actions = (
    <span className="channel-actions">
      <Tooltip content="Create Invite" side="top">
        <button type="button" className="channel-action" aria-label="Create Invite" onClick={e => (e.preventDefault(), openModal({ type: "invite", channelId: channel.id }))}>
          <UserPlus size={16} />
        </button>
      </Tooltip>
      {isOwner && (
        <Tooltip content="Edit Channel" side="top">
          <button type="button" className="channel-action" aria-label="Edit Channel" onClick={e => (e.preventDefault(), openModal({ type: "editChannel", channelId: channel.id }))}>
            <Settings size={16} />
          </button>
        </Tooltip>
      )}
    </span>
  );

  return (
    <li className="channel-row-wrap">
      {voice ? (
        <div className={className} role="button" tabIndex={0} aria-label={`${channel.name} voice channel`} onContextMenu={e => menu.open(e, items())}>
          {icon}
          <span className="channel-name">{channel.name}</span>
          {actions}
        </div>
      ) : (
        <NavLink to={guildPath(guild.id, channel.id)} className={className} onContextMenu={e => menu.open(e, items())}>
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
  const firstText = useStore(s => Object.values(s.channels).find(c => c.guild_id === guild.id && c.type === ChannelType.GuildText));
  // Subscribing re-renders the menu when a mute/hide flag changes while it is open.
  useLocalState(s => s.hideMuted[guild.id]);
  const items = open ? guildDropdownItems(guild) : [];
  return (
    <>
      <div ref={setAnchor} className={`guild-header${open ? " open" : ""}`}>
        <button type="button" className="guild-header-name-button" onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open}>
          <span className="guild-header-name">{guild.name}</span>
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        <Tooltip content="Invite People" side="bottom">
          <button type="button" className="guild-header-invite" aria-label="Invite People" disabled={!firstText} onClick={() => firstText && openModal({ type: "invite", channelId: firstText.id })}>
            <UserPlus size={20} />
          </button>
        </Tooltip>
      </div>
      <Popout anchor={anchor} open={open} onClose={() => setOpen(false)} side="bottom" align="center" gap={4} className="guild-menu" style={{ width: 220 }}>
        <div role="menu" className="guild-menu-list">
          {items.map((item, index) => {
            if ("type" in item) return <div key={`sep-${index}`} className="guild-menu-separator" />;
            const checkbox = item.checked !== undefined;
            return (
              <button
                key={item.id}
                type="button"
                role={checkbox ? "menuitemcheckbox" : "menuitem"}
                aria-checked={item.checked}
                aria-disabled={item.disabled || undefined}
                title={item.tooltip}
                className={`guild-menu-item${item.danger ? " danger" : ""}`}
                onClick={() => {
                  if (item.disabled) return;
                  if (!checkbox) setOpen(false);
                  item.onSelect?.();
                }}
              >
                <span>{item.label}</span>
                {checkbox ? <span className={`guild-menu-check${item.checked ? " on" : ""}`}>{item.checked && <Check size={14} strokeWidth={3} />}</span> : (item.icon ?? null)}
              </button>
            );
          })}
        </div>
      </Popout>
    </>
  );
}

export function GuildSidebar({ guild }: { guild: Guild }) {
  const location = useLocation();
  const menu = useContextMenu();
  const channels = useStore(s => Object.values(s.channels).filter(c => c.guild_id === guild.id));
  const unreadIds = useStore(s => channels.filter(c => isChannelUnread(s, c.id)).map(c => c.id));
  const [collapsed, setCollapsed] = useState<Set<Snowflake>>(loadCollapsed);
  const mutedUntil = useLocalState(s => s.mutedUntil);
  const hideMuted = useLocalState(s => !!s.hideMuted[guild.id]);
  const isOwner = useStore(s => s.me?.id === guild.owner_id);
  const selectedId = location.pathname.split("/")[3];
  const isMuted = (id: Snowflake | null) => {
    const until = id ? mutedUntil[id] : undefined;
    return until === -1 || (until !== undefined && until > Date.now());
  };
  const shown = useMemo(
    () => (hideMuted ? channels.filter(c => c.id === selectedId || !(isMuted(c.id) || isMuted(c.parent_id))) : channels),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channels, hideMuted, mutedUntil, selectedId],
  );
  const groups = useMemo(() => groupChannels(shown), [shown]);

  const persist = (next: Set<Snowflake>) => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
    return next;
  };
  const toggle = (id: Snowflake) =>
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return persist(next);
    });
  const categoryIds = groups.flatMap(g => (g.category ? [g.category.id] : []));

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
                  <div
                    className={`category-header${isCollapsed ? " collapsed" : ""}${isMuted(category.id) ? " muted" : ""}`}
                    onContextMenu={e =>
                      menu.open(
                        e,
                        channelContextItems(category, guild, {
                          collapsed: isCollapsed,
                          onToggleCollapse: () => toggle(category.id),
                          anyExpanded: categoryIds.some(id => !collapsed.has(id)),
                          onCollapseAll: () => setCollapsed(persist(new Set(categoryIds))),
                        }),
                      )
                    }
                  >
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
