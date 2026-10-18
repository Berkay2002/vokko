import { useCallback, useState } from "react";
import { Bell, BellOff, ChevronRight, Hash, Lock, Megaphone, MessageCircle, MessagesSquare, Phone, Pin, Radio, Search, UserPlus, UserRound, Users, Video, Volume2 } from "lucide-react";
import { useVoiceUi } from "../voice";
import { useShortcut } from "../keyboard";
import { dmName, useStore } from "../api/store";
import { ChannelType, type Channel } from "../api/types";
import { PinnedMessages } from "../chat/PinnedMessages";
import { ThreadsToolbar } from "../threads/ThreadsToolbar";
import { Popout, Tooltip, useContextMenu, usePhone } from "../ui";
import { Avatar } from "./Avatar";
import { isPrivateChannel } from "./channelPrivacy";
import { NavToggle } from "./NavToggle";
import { muteItem, notificationItem, UNAVAILABLE } from "./menus";
import { openModal } from "./modalStore";
import { channelSlots } from "./slots";
import { useIsMuted } from "./localState";
import { NsfwHash } from "../guild/icons";
import "../guild/guild.css";

function ToolbarButton({
  label,
  active,
  disabled,
  secondary,
  onClick,
  children,
  buttonRef,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  /** Hidden on a phone (the details page has it). */
  secondary?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
  buttonRef?: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <Tooltip content={disabled ? `${label} (${UNAVAILABLE.toLowerCase()})` : label} side="bottom">
      <button ref={buttonRef} type="button" className={`toolbar-button${secondary ? " secondary" : ""}${active ? " active" : ""}`} aria-label={label} aria-pressed={active} aria-disabled={disabled || undefined} onClick={disabled ? undefined : onClick}>
        {children}
      </button>
    </Tooltip>
  );
}

export interface ChannelHeaderProps {
  channel: Channel;
  membersOpen: boolean;
  onToggleMembers(): void;
  /** DM user profile side panel (1:1 DMs only). */
  profileOpen: boolean;
  onToggleProfile(): void;
  /** Age gate not confirmed yet: show only the name and icon. */
  gated?: boolean;
  /** Phone: the name opens the details page (members, pins, threads). */
  onOpenDetails(): void;
}

/** 48 px header above the message area: channel/DM identity on the left, toolbar on the right. */
export function ChannelHeader({ channel, membersOpen, onToggleMembers, profileOpen, onToggleProfile, gated, onOpenDetails }: ChannelHeaderProps) {
  const [pinsAnchor, setPinsAnchor] = useState<HTMLElement | null>(null);
  const [pinsOpen, setPinsOpen] = useState(false);
  const muted = useIsMuted(channel.id);
  const closePins = useCallback(() => setPinsOpen(false), []);
  const menu = useContextMenu();
  const guild = !!channel.guild_id;
  const voice = channel.type === ChannelType.GuildVoice;
  const chatOpen = useVoiceUi(s => s.chatOpen);
  const announcement = channel.type === ChannelType.GuildAnnouncement;
  const forum = channel.type === ChannelType.GuildForum;
  const first = channel.recipients?.[0];
  const group = channel.type === ChannelType.GroupDM;
  useShortcut("pins", () => setPinsOpen(o => !o), !voice && !forum && !gated);
  const oneToOne = !guild && !group && !!first;
  // "N online" under the name, phone only (it walks every member on each store update); counted only for server channels.
  const phone = usePhone();
  const online = useStore(s => {
    if (!phone || !channel.guild_id) return 0;
    let n = 0;
    for (const id in s.members[channel.guild_id]) if ((s.presences[id]?.status ?? "offline") !== "offline") n++;
    return n;
  });

  const bell = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    menu.open({ clientX: rect.left, clientY: rect.bottom + 4 }, [muteItem(channel.id, group ? "Conversation" : "Channel"), notificationItem(channel.id)]);
  };

  return (
    <header className="channel-header">
      <div className="channel-header-title">
        <NavToggle />
        {guild ? (
          <>
            {isPrivateChannel(channel, channel.guild_id) ? (
              <Lock size={24} className="channel-header-icon" />
            ) : voice ? (
              <Volume2 size={24} className="channel-header-icon" />
            ) : channel.type === ChannelType.GuildStage ? (
              <Radio size={24} className="channel-header-icon" />
            ) : announcement ? (
              <Megaphone size={24} className="channel-header-icon" />
            ) : forum ? (
              <MessagesSquare size={24} className="channel-header-icon" />
            ) : channel.nsfw ? (
              <NsfwHash size={24} className="channel-header-icon" />
            ) : (
              <Hash size={24} className="channel-header-icon" />
            )}
            <div className="channel-header-name-wrap">
              <h1 className="channel-header-name">{channel.name}</h1>
              <ChevronRight size={16} className="channel-header-chevron" aria-hidden="true" />
              {phone && !voice && !gated && <span className="channel-header-online">{online} online</span>}
              {/* Covers the name where the topic hides (responsive.css), so the topic dialog stays reachable without taking header width. It is described by the (hidden) topic button, so screen readers still get the text. */}
              {channel.topic && !gated && (
                <button type="button" className="channel-header-topic-entry" title={channel.topic} aria-describedby={`channel-topic-${channel.id}`} aria-haspopup="dialog" aria-label={`${channel.name}, channel topic`} onClick={() => openModal({ type: "channelTopic", channelId: channel.id })} />
              )}
            </div>
            {channel.topic && !gated && (
              <>
                <span className="channel-header-divider" />
                <button type="button" id={`channel-topic-${channel.id}`} className="channel-header-topic" title={channel.topic} aria-haspopup="dialog" aria-label={`Channel topic: ${channel.topic.length > 120 ? `${channel.topic.slice(0, 120)}...` : channel.topic}`} onClick={() => openModal({ type: "channelTopic", channelId: channel.id })}>
                  {channel.topic}
                </button>
              </>
            )}
          </>
        ) : (
          <>
            {oneToOne ? <Avatar user={first} size={24} status /> : <Users size={24} className="channel-header-icon" />}
            <h1 className="channel-header-name">{dmName(channel)}</h1>
            <ChevronRight size={16} className="channel-header-chevron" aria-hidden="true" />
          </>
        )}
        {!gated && <button type="button" className="channel-header-details" aria-label={`${guild ? channel.name : dmName(channel)}, details`} onClick={onOpenDetails} />}
      </div>
      <div className="channel-header-toolbar">
        {gated ? null : <>
        {guild ? (
          <>
            {voice ? (
              <ToolbarButton label={chatOpen ? "Hide Chat" : "Show Chat"} active={chatOpen} onClick={() => useVoiceUi.getState().setChatOpen(!chatOpen)}>
                <MessageCircle size={24} />
              </ToolbarButton>
            ) : (
              <ThreadsToolbar channel={channel} />
            )}
            <ToolbarButton label="Notification Settings" secondary active={muted} onClick={bell}>
              {muted ? <BellOff size={24} /> : <Bell size={24} />}
            </ToolbarButton>
          </>
        ) : (
          channelSlots.DmCallButtons ? (
            <channelSlots.DmCallButtons channel={channel} />
          ) : (
            <>
              <ToolbarButton label="Start Voice Call" disabled>
                <Phone size={24} />
              </ToolbarButton>
              <ToolbarButton label="Start Video Call" disabled>
                <Video size={24} />
              </ToolbarButton>
            </>
          )
        )}
        {!voice && !forum && (
          <ToolbarButton label="Pinned Messages" secondary active={pinsOpen} onClick={() => setPinsOpen(o => !o)} buttonRef={setPinsAnchor}>
            <Pin size={24} />
          </ToolbarButton>
        )}
        {!guild && (
          <ToolbarButton label="Add Friends to DM" secondary onClick={() => openModal({ type: "createDM", base: (channel.recipients ?? []).map(r => r.id), groupId: channel.type === ChannelType.GroupDM ? channel.id : undefined })}>
            <UserPlus size={24} />
          </ToolbarButton>
        )}
        {guild && !voice && (
          <ToolbarButton label={membersOpen ? "Hide Member List" : "Show Member List"} secondary active={membersOpen} onClick={onToggleMembers}>
            <Users size={24} />
          </ToolbarButton>
        )}
        {oneToOne && (
          <ToolbarButton label={profileOpen ? "Hide User Profile" : "Show User Profile"} secondary active={profileOpen} onClick={onToggleProfile}>
            <UserRound size={24} />
          </ToolbarButton>
        )}
        {voice ? null : channelSlots.HeaderSearch ? (
          <channelSlots.HeaderSearch channel={channel} />
        ) : (
          <div className="header-search">
            <input className="header-search-input" placeholder={"Search"} aria-label="Search" />
            <Search size={16} />
          </div>
        )}
        </>}
      </div>
      <Popout anchor={pinsAnchor} open={pinsOpen && !gated} onClose={() => setPinsOpen(false)} side="bottom" align="end" gap={8} className="pins-popout-host">
        <PinnedMessages channelId={channel.id} onNavigate={closePins} />
      </Popout>
    </header>
  );
}
