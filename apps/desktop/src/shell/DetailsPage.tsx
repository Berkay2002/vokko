import { useState } from "react";
import { ArrowLeft, Bell, BellOff, ChevronRight, Hash, Lock, Megaphone, MessagesSquare, Search, Settings, UserPlus, Users, Volume2 } from "lucide-react";
import { Perm } from "../api/permissions";
import { displayName, dmName, useStore } from "../api/store";
import { ChannelType, type Channel } from "../api/types";
import { PinnedMessages } from "../chat/PinnedMessages";
import { ThreadsPopout } from "../threads/ThreadsPopout";
import { hasThreadsType } from "../threads/util";
import { useContextMenu } from "../ui";
import { Avatar } from "./Avatar";
import { DmProfilePanel } from "./DmProfilePanel";
import { isPrivateChannel } from "./channelPrivacy";
import { useIsMuted } from "./localState";
import { MemberList } from "./MemberList";
import { channelContextItems, muteItem, notificationItem } from "./menus";
import { openModal } from "./modalStore";
import { usePermissions } from "./usePermissions";
import "./details.css";

type Tab = "members" | "pins" | "threads";

function typeLabel(channel: Channel): string {
  switch (channel.type) {
    case ChannelType.GuildVoice:
      return "Voice Channel";
    case ChannelType.GuildAnnouncement:
      return "Announcement Channel";
    case ChannelType.GuildForum:
      return "Forum Channel";
    case ChannelType.GroupDM:
      return "Group Message";
    case ChannelType.DM:
      return "Direct Message";
    default:
      return "Text Channel";
  }
}

/**
 * Phone (<= 767px): the page behind the header name of a channel or DM. It carries what the desktop header toolbar and side panels
 * hold: the member list (or the DM profile), pinned messages, threads, notification settings and the channel menu.
 */
export function DetailsPage({ channel, onClose }: { channel: Channel; onClose(): void }) {
  const guild = useStore(s => (channel.guild_id ? s.guilds[channel.guild_id] : undefined));
  const { can } = usePermissions(channel.guild_id, channel.id);
  const muted = useIsMuted(channel.id);
  const menu = useContextMenu();
  const [tab, setTab] = useState<Tab>("members");
  const voice = channel.type === ChannelType.GuildVoice;
  const forum = channel.type === ChannelType.GuildForum;
  const group = channel.type === ChannelType.GroupDM;
  const first = channel.recipients?.[0];
  const oneToOne = !guild && !group && !!first;
  const name = guild ? (channel.name ?? "") : dmName(channel);
  const tabs: { id: Tab; label: string }[] = [
    { id: "members", label: oneToOne ? "Profile" : "Members" },
    ...(!voice && !forum ? [{ id: "pins" as const, label: "Pins" }] : []),
    ...(hasThreadsType(channel) ? [{ id: "threads" as const, label: "Threads" }] : []),
  ];

  const search = () => {
    onClose();
    // the header search is an icon until focused; focusing the (invisible) input opens it
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".header-search-input")?.focus());
  };
  const bell = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    menu.open({ clientX: rect.right, clientY: rect.bottom + 4 }, [muteItem(channel.id, group ? "Conversation" : "Channel"), notificationItem(channel.id)]);
  };
  const more = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!guild) return;
    const rect = event.currentTarget.getBoundingClientRect();
    menu.open({ clientX: rect.right, clientY: rect.bottom + 4 }, channelContextItems(channel, guild));
  };
  const Icon = isPrivateChannel(channel, channel.guild_id) ? Lock : voice ? Volume2 : channel.type === ChannelType.GuildAnnouncement ? Megaphone : forum ? MessagesSquare : Hash;

  return (
    <section className="details-page" aria-label="Details">
      <div className="details-bar">
        <button type="button" className="details-icon-button" aria-label="Back" onClick={onClose}>
          <ArrowLeft size={24} />
        </button>
        <span className="details-bar-spacer" />
        {!voice && (
          <button type="button" className="details-icon-button" aria-label="Search" onClick={search}>
            <Search size={24} />
          </button>
        )}
        <button type="button" className="details-icon-button" aria-label="Notification Settings" onClick={bell}>
          {muted ? <BellOff size={24} /> : <Bell size={24} />}
        </button>
        {guild && (
          <button type="button" className="details-icon-button" aria-label="Channel Menu" onClick={more}>
            <Settings size={24} />
          </button>
        )}
      </div>
      <div className="details-identity">
        {oneToOne ? (
          <Avatar user={first} size={48} status />
        ) : (
          <span className="details-identity-icon">{guild ? <Icon size={28} /> : <Users size={28} />}</span>
        )}
        <div className="details-identity-text">
          <div className="details-name">{name}</div>
          <div className="details-sub">{oneToOne ? first.username : typeLabel(channel)}</div>
        </div>
      </div>
      {channel.topic && <p className="details-topic">{channel.topic}</p>}
      {tabs.length > 1 && (
        <div className="details-tabs" role="tablist">
          {tabs.map(t => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`details-tab${tab === t.id ? " selected" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className="details-body" role="tabpanel">
        {tab === "members" && guild && !voice && (
          <>
            {can(Perm.CREATE_INSTANT_INVITE) && (
              <button type="button" className="details-row" onClick={() => openModal({ type: "invite", channelId: channel.id })}>
                <UserPlus size={24} />
                <span>Invite Members</span>
                <ChevronRight size={20} className="details-row-chevron" />
              </button>
            )}
            <MemberList guildId={guild.id} />
          </>
        )}
        {tab === "members" && oneToOne && <DmProfilePanel user={first} />}
        {tab === "members" && group && (
          <ul className="details-people">
            {(channel.recipients ?? []).map(u => (
              <li key={u.id}>
                <Avatar user={u} size={32} status />
                <span>{displayName(u)}</span>
              </li>
            ))}
          </ul>
        )}
        {tab === "pins" && <PinnedMessages channelId={channel.id} onNavigate={onClose} />}
        {tab === "threads" && <ThreadsPopout channel={channel} onClose={onClose} />}
      </div>
    </section>
  );
}
