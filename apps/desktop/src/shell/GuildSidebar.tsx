import { memo, useMemo, useState, type CSSProperties } from "react";
import { resolveUrl } from "../api/rest";
import { intToHex } from "../perks/catalog";
import { NavLink, useLocation } from "react-router";
import { Check, ChevronDown, ChevronRight, ChevronUp, Hash, Lock, Megaphone, MessagesSquare, Plus, Radio, Settings, UserPlus } from "lucide-react";
import { channelMentionCount, isChannelUnread, useStore } from "../api/store";
import { StageLivePill, VoiceChannelRow, VoiceChannelUsers } from "../voice";
import { ChannelType, type Channel, type Guild, type Snowflake } from "../api/types";
import { Popout, Tooltip, useContextMenu } from "../ui";
import { EventsQuickLink } from "../community";
import { MembersQuickLink } from "../members";
import { groupChannels } from "./channels";
import { useIsMuted, useLocalState, useMuteLapse } from "./localState";
import { channelContextItems, guildDropdownItems } from "./menus";
import { Perm } from "../api/permissions";
import { ChannelThreads } from "../threads/ChannelThreads";
import { isPrivateChannel } from "./channelPrivacy";
import { guildPath } from "./nav";
import { usePermissions } from "./usePermissions";
import { openModal } from "./modalStore";
import { NsfwHash } from "../guild/icons";
import { useChannelDrag } from "../guild/useChannelDrag";
import "../guild/guild.css";

const COLLAPSED_KEY = "vokko.collapsedCategories";
/** Height of the banner image at the top of the channel list (Discord: 138 px including the 49 px header it sits under). */
const BANNER_HEIGHT = 138;

function loadCollapsed(): Set<Snowflake> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as Snowflake[]);
  } catch {
    return new Set();
  }
}

// Memoised, and `selected` comes from the list: a gateway event or a route change re-renders only the rows it touches.
const ChannelRow = memo(function ChannelRow({ channel, guild, selected }: { channel: Channel; guild: Guild; selected: boolean }) {
  const unread = useStore(s => isChannelUnread(s, channel.id));
  const mentions = useStore(s => channelMentionCount(s, channel.id));
  const { can } = usePermissions(guild.id, channel.id);
  // Both hooks run on every render (a short-circuit would change the hook count when the channel's own mute flips).
  const selfMuted = useIsMuted(channel.id);
  const parentMuted = useIsMuted(channel.parent_id);
  const muted = selfMuted || parentMuted;
  const menu = useContextMenu();
  const className = `channel-row${selected ? " selected" : ""}${unread && !muted ? " unread" : ""}${muted ? " muted" : ""}`;
  const items = () => channelContextItems(channel, guild);
  const stage = channel.type === ChannelType.GuildStage;

  const icon = isPrivateChannel(channel, guild.id) ? (
    <Lock size={20} className="channel-icon" />
  ) : channel.type === ChannelType.GuildAnnouncement ? (
    <Megaphone size={20} className="channel-icon" />
  ) : channel.type === ChannelType.GuildForum ? (
    <MessagesSquare size={20} className="channel-icon" />
  ) : channel.type === ChannelType.GuildStage ? (
    <Radio size={20} className="channel-icon" />
  ) : channel.nsfw ? (
    <NsfwHash size={20} className="channel-icon" />
  ) : (
    <Hash size={20} className="channel-icon" />
  );
  const actions = (
    <span className="channel-actions">
      {can(Perm.CREATE_INSTANT_INVITE) && (
        <Tooltip content="Create Invite" side="top">
          <button type="button" className="channel-action" aria-label="Create Invite" onClick={e => (e.preventDefault(), openModal({ type: "invite", channelId: channel.id }))}>
            <UserPlus size={16} />
          </button>
        </Tooltip>
      )}
      {can(Perm.MANAGE_CHANNELS) && (
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
      <NavLink to={guildPath(guild.id, channel.id)} className={className} onContextMenu={e => menu.open(e, items())}>
        {icon}
        <span className="channel-name">{channel.name}</span>
        {stage && <StageLivePill channelId={channel.id} />}
        {mentions > 0 ? <span className="count-badge">{mentions}</span> : null}
        {actions}
      </NavLink>
      {stage ? <VoiceChannelUsers channel={channel} guildId={guild.id} /> : <ChannelThreads channel={channel} />}
    </li>
  );
});

const MemoVoiceChannelRow = memo(VoiceChannelRow);

function GuildHeader({ guild, overBanner }: { guild: Guild; overBanner: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const canInvite = usePermissions(guild.id).can(Perm.CREATE_INSTANT_INVITE);
  const firstText = useStore(s => Object.values(s.channels).find(c => c.guild_id === guild.id && c.type === ChannelType.GuildText));
  // Subscribing re-renders the menu when a mute/hide flag changes while it is open.
  useLocalState(s => s.hideMuted[guild.id]);
  const items = open ? guildDropdownItems(guild) : [];
  return (
    <>
      <div
        ref={setAnchor}
        className={`guild-header${open ? " open" : ""}${guild.theme ? " themed" : ""}${guild.banner ? " has-banner" : ""}${overBanner ? " over-banner" : ""}`}
        style={guild.theme ? ({ "--guild-theme-gradient": `linear-gradient(135deg, ${intToHex(guild.theme.primary)}, ${intToHex(guild.theme.accent)})` } as CSSProperties) : undefined}
      >
        <button type="button" className="guild-header-name-button" onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open}>
          <span className="guild-header-name">{guild.name}</span>
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {canInvite && (
          <Tooltip content="Invite People" side="bottom">
            <button type="button" className="guild-header-invite" aria-label="Invite People" disabled={!firstText} onClick={() => firstText && openModal({ type: "invite", channelId: firstText.id })}>
              <UserPlus size={20} />
            </button>
          </Tooltip>
        )}
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
  const perms = usePermissions(guild.id);
  const canManageChannels = perms.can(Perm.MANAGE_CHANNELS);
  const selectedId = location.pathname.split("/")[3];
  const isMuted = (id: Snowflake | null) => {
    const until = id ? mutedUntil[id] : undefined;
    return until === -1 || (until !== undefined && until > Date.now());
  };
  // a lapsed timed mute brings its channel back: re-filter when the soonest one ends
  const lapses = useMuteLapse(hideMuted ? channels.flatMap(c => [mutedUntil[c.id], c.parent_id ? mutedUntil[c.parent_id] : undefined]) : []);
  const shown = useMemo(
    () => (hideMuted ? channels.filter(c => c.id === selectedId || !(isMuted(c.id) || isMuted(c.parent_id))) : channels),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channels, hideMuted, mutedUntil, selectedId, lapses],
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
  const drag = useChannelDrag(guild, channels, canManageChannels);
  // Banner variant: the image sits at the top of the scroller under a transparent header and fades out as the list scrolls.
  const [scrollTop, setScrollTop] = useState(0);
  const banner = guild.banner ? resolveUrl(guild.banner) : null;
  const bannerFade = Math.min(1, scrollTop / (BANNER_HEIGHT - 49));

  return (
    <div className={`sidebar-list guild-sidebar${banner ? " with-banner" : ""}`}>
      <GuildHeader guild={guild} overBanner={!!banner && bannerFade < 1} />
      {!banner && (
        <>
          <EventsQuickLink guildId={guild.id} />
          <MembersQuickLink guild={guild} />
        </>
      )}
      <div className="sidebar-scroller channel-scroller" onScroll={banner ? e => setScrollTop(e.currentTarget.scrollTop) : undefined}>
        {banner && (
          <>
            <div className="guild-banner" style={{ backgroundImage: `url("${banner}")`, opacity: 1 - bannerFade }} aria-hidden="true" />
            <EventsQuickLink guildId={guild.id} />
            <MembersQuickLink guild={guild} />
          </>
        )}
        <ul className={`channel-list${drag.dragging ? " drag-active" : ""}`} aria-label="Channels" {...drag.handlers}>
          {groups.map(group => {
            const { category } = group;
            const isCollapsed = !!category && collapsed.has(category.id);
            const visible = isCollapsed ? group.channels.filter(c => c.id === selectedId || unreadIds.includes(c.id)) : group.channels;
            return (
              <li key={category?.id ?? "loose"} className="category">
                {category && (
                  <div
                    className={`category-header${isCollapsed ? " collapsed" : ""}${isMuted(category.id) ? " muted" : ""}${drag.dropClass(category.id)}${drag.dragging === category.id ? " dragging" : ""}`}
                    data-drag-id={category.id}
                    draggable={canManageChannels || undefined}
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
                    {canManageChannels && (
                      <Tooltip content="Create Channel" side="top">
                        <button type="button" className="category-add" aria-label="Create Channel" onClick={() => openModal({ type: "createChannel", guildId: guild.id, parentId: category.id })}>
                          <Plus size={16} />
                        </button>
                      </Tooltip>
                    )}
                  </div>
                )}
                <ul className="category-channels" ref={el => drag.markRows(el, visible)}>
                  {visible.map(c =>
                    c.type === ChannelType.GuildVoice ? (
                      <MemoVoiceChannelRow key={c.id} channel={c} guild={guild} />
                    ) : (
                      <ChannelRow key={c.id} channel={c} guild={guild} selected={c.id === selectedId} />
                    ),
                  )}
                </ul>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
