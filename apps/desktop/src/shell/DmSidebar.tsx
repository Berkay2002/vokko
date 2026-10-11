import { NavLink, useLocation } from "react-router";
import { Plus, Users, X } from "lucide-react";
import { channelMentionCount, dmName, isChannelUnread, useStore } from "../api/store";
import { ChannelType, RelationshipType, type Channel } from "../api/types";
import { Tooltip, useContextMenu } from "../ui";
import { TagChip } from "../perks/TagChip";
import { Avatar } from "./Avatar";
import { closeDirectMessage } from "./actions";
import { useIsMuted } from "./localState";
import { dmContextItems } from "./menus";
import { openModal } from "./modalStore";

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

  return (
    <li className="dm-row-wrap">
      <NavLink
        to={`/channels/@me/${channel.id}`}
        className={`dm-row${selected ? " selected" : ""}${unread && !muted ? " unread" : ""}${muted ? " muted" : ""}`}
        onContextMenu={e => menu.open(e, dmContextItems(channel, { anchor: e.currentTarget }))}
      >
        {group || !first ? (
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
            <span className="dm-name">{dmName(channel)}</span>
            {!group && <span className="dm-tag" aria-hidden="true"><TagChip tag={first?.primary_guild} /></span>}
          </span>
          {group && <span className="dm-sub">{recipients.length + 1} members</span>}
        </span>
        {mentions > 0 && <span className="count-badge">{mentions}</span>}
      </NavLink>
      <Tooltip content="Close DM" side="top">
        <button type="button" className="dm-close" aria-label="Close DM" onClick={() => void closeDirectMessage(channel.id)}>
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
          <span>Direct Messages</span>
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
      </div>
    </div>
  );
}
