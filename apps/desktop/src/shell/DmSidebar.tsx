import { NavLink, useLocation } from "react-router";
import { Plus, Users, Volume2, X } from "lucide-react";
import { useVoice } from "../voice";
import { channelMentionCount, dmName, isChannelUnread, useStore } from "../api/store";
import { ChannelType, RelationshipType, type Channel, type PresenceStatus } from "../api/types";
import { Tooltip, useContextMenu } from "../ui";
import { TagChip } from "../perks/TagChip";
import { Nameplate, nameplateRowClass } from "../perks/NameStyles";
import { Avatar } from "./Avatar";
import { closeDirectMessage } from "./actions";
import { useIsMuted } from "./localState";
import { playingVerb } from "../activity/format";
import { ActivityLine, useShownActivity } from "./ActivityLine";
import { dmContextItems } from "./menus";
import { openModal } from "./modalStore";
import { channelSlots } from "./slots";
import { GroupIcon } from "./GroupDm";

const STATUS_LABEL: Record<PresenceStatus, string> = { online: "online", idle: "idle", dnd: "do not disturb", invisible: "offline", offline: "offline" };

/** The unread part of a DM's accessible name, shared with its rail item: "1 mention", "3 mentions", "unread" or nothing. */
export function unreadLabel(mentions: number, unread: boolean): string | null {
  if (mentions > 0) return `${mentions} mention${mentions === 1 ? "" : "s"}`;
  return unread ? "unread" : null;
}

function DmRow({ channel }: { channel: Channel }) {
  const location = useLocation();
  const selected = location.pathname === `/channels/@me/${channel.id}`;
  const unread = useStore(s => isChannelUnread(s, channel.id));
  const mentions = useStore(s => channelMentionCount(s, channel.id));
  const menu = useContextMenu();
  const muted = useIsMuted(channel.id);
  const recipients = channel.recipients ?? [];
  const group = channel.type === ChannelType.GroupDM;
  const first = recipients[0];
  const playing = useShownActivity(group ? null : first?.id);
  // Subtitle under a 1:1 DM's name: "Playing X" (the main activity), else "In voice" while they sit in a voice channel we can see, else their custom status.
  // Voice states are not cleared while the gateway reconnects (presences are, see applyConnection): hide the line until READY/RESUMED, like Discord.
  const live = useStore(s => s.connection === "ready");
  const inVoice = useVoice(s => live && !group && !!first && !!s.states[first.id]?.channel_id);
  const status = useStore(s => (!group && first ? (s.presences[first.id]?.status ?? "offline") : null));
  const custom = useStore(s => (!group && first ? s.presences[first.id]?.custom_status : null));
  const name = dmName(channel);
  // The link's name starts with the DM's name (Discord: "Alice (direct message)"), then unread state, presence and activity.
  const label = [
    name,
    unreadLabel(muted ? 0 : mentions, unread && !muted),
    status && STATUS_LABEL[status],
    playing ? (playing.type === 2 ? "listening to Spotify" : `${playingVerb(playing).toLowerCase()} ${playing.name}`) : inVoice ? "in voice" : custom,
    group ? `${recipients.length + 1} members` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <li className="dm-row-wrap">
      <NavLink
        to={`/channels/@me/${channel.id}`}
        className={`dm-row${selected ? " selected" : ""}${unread && !muted ? " unread" : ""}${muted ? " muted" : ""}${group ? "" : nameplateRowClass(first?.nameplate)}`}
        aria-label={label}
        onContextMenu={e => menu.open(e, dmContextItems(channel, { anchor: e.currentTarget }))}
      >
        {!group && <Nameplate id={first?.nameplate} />}
        {group && channel.icon ? (
          <GroupIcon channel={channel} size={32} />
        ) : group || !first ? (
          <span className="dm-group-avatar">
            {recipients.slice(0, 2).map((r, i) => (
              <Avatar key={r.id} user={r} size={24} className={`dm-group-avatar-${i}`} />
            ))}
          </span>
        ) : (
          <Avatar user={first} size={32} status />
        )}
        <span className="dm-text">
          <span className="dm-name-row">
            <span className="dm-name">{name}</span>
            {!group && <span className="dm-tag" aria-hidden="true"><TagChip tag={first?.primary_guild} /></span>}
          </span>
          {group && <span className="dm-sub">{recipients.length + 1} members</span>}
          {playing ? (
            <ActivityLine activity={playing} className="dm-sub dm-activity" variant="song" />
          ) : inVoice ? (
            <span className="dm-sub dm-activity voice">
              <Volume2 size={12} strokeWidth={2.5} aria-hidden="true" />
              In voice
            </span>
          ) : (
            custom && <span className="dm-sub dm-activity">{custom}</span>
          )}
        </span>
        {channelSlots.DmBadge && <channelSlots.DmBadge channelId={channel.id} />}
      </NavLink>
      <Tooltip content={group ? "Leave Group" : "Close DM"} side="top">
        <button
          type="button"
          className="dm-close"
          aria-label={group ? "Leave Group" : "Close DM"}
          onClick={() => (group ? openModal({ type: "leaveGroup", channelId: channel.id }) : void closeDirectMessage(channel.id))}
        >
          <X size={16} />
        </button>
      </Tooltip>
    </li>
  );
}

export function DmSidebar() {
  const location = useLocation();
  const privateChannels = useStore(s => s.privateChannels.map(id => s.channels[id]).filter((c): c is Channel => !!c));
  const pending = useStore(s => Object.values(s.relationships).filter(r => r.type === RelationshipType.IncomingRequest).length);
  const friendsSelected = location.pathname === "/channels/@me";

  return (
    <div className="sidebar-list dm-sidebar">
      <div className="sidebar-search">
        <button type="button" className="sidebar-search-button" onClick={() => openModal({ type: "quickSwitcher" })}>
          Find or start a conversation
        </button>
      </div>
      <div className="sidebar-scroller">
        <nav className="sidebar-nav" aria-label="Home">
          <div className="nav-row-wrap">
            <NavLink to="/channels/@me" end className={`nav-row${friendsSelected ? " selected" : ""}`}>
              <Users size={20} />
              <span className="nav-row-label">Friends</span>
              {pending > 0 && <span className="count-badge">{pending}</span>}
            </NavLink>
          </div>
        </nav>
        <div className="dm-section-header">
          <span role="heading" aria-level={2}>Direct Messages</span>
          <Tooltip content="Create DM" side="top">
            <button type="button" className="dm-create" aria-label="Create DM" onClick={() => openModal({ type: "createDM" })}>
              <Plus size={16} />
            </button>
          </Tooltip>
        </div>
        <ul className="dm-list" aria-label="Direct messages">
          {privateChannels.map(c => (
            <DmRow key={c.id} channel={c} />
          ))}
        </ul>
        {/* No conversations yet: fading placeholder rows show where they will appear, like Discord. */}
        {privateChannels.length === 0 && (
          <div className="dm-placeholders" aria-hidden="true">
            {[0.6, 0.45, 0.7, 0.5, 0.4, 0.55].map((width, i) => (
              <div key={i} className="dm-placeholder" style={{ opacity: 1 - i * 0.15 }}>
                <span className="dm-placeholder-avatar" />
                <span className="dm-placeholder-name" style={{ width: `${width * 100}%` }} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
