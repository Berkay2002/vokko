import { useCallback, useState } from "react";
import { Bell, Hash, Lock, Megaphone, MessageCircle, MessagesSquare, Phone, Pin, Search, UserPlus, UserRound, Users, Video, Volume2 } from "lucide-react";
import { useVoiceUi } from "../voice";
import { useShortcut } from "../keyboard";
import { dmName } from "../api/store";
import { ChannelType, type Channel } from "../api/types";
import { PinnedMessages } from "../chat/PinnedMessages";
import { ThreadsToolbar } from "../threads/ThreadsToolbar";
import { Popout, Tooltip, useContextMenu } from "../ui";
import { Avatar } from "./Avatar";
import { isPrivateChannel } from "./channelPrivacy";
import { NavToggle } from "./NavToggle";
import { muteItem, notificationItem, UNAVAILABLE } from "./menus";
import { openModal } from "./modalStore";
import { channelSlots } from "./slots";

function ToolbarButton({
  label,
  active,
  disabled,
  onClick,
  children,
  buttonRef,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
  buttonRef?: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <Tooltip content={disabled ? `${label} (${UNAVAILABLE.toLowerCase()})` : label} side="bottom">
      <button ref={buttonRef} type="button" className={`toolbar-button${active ? " active" : ""}`} aria-label={label} aria-pressed={active} aria-disabled={disabled || undefined} onClick={disabled ? undefined : onClick}>
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
}

/** 48 px header above the message area: channel/DM identity on the left, toolbar on the right. */
export function ChannelHeader({ channel, membersOpen, onToggleMembers, profileOpen, onToggleProfile }: ChannelHeaderProps) {
  const [pinsAnchor, setPinsAnchor] = useState<HTMLElement | null>(null);
  const [pinsOpen, setPinsOpen] = useState(false);
  const closePins = useCallback(() => setPinsOpen(false), []);
  const menu = useContextMenu();
  const guild = !!channel.guild_id;
  const voice = channel.type === ChannelType.GuildVoice;
  const chatOpen = useVoiceUi(s => s.chatOpen);
  const announcement = channel.type === ChannelType.GuildAnnouncement;
  const forum = channel.type === ChannelType.GuildForum;
  const first = channel.recipients?.[0];
  const group = channel.type === ChannelType.GroupDM;
  useShortcut("pins", () => setPinsOpen(o => !o), !voice && !forum);
  const oneToOne = !guild && !group && !!first;

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
            ) : announcement ? (
              <Megaphone size={24} className="channel-header-icon" />
            ) : forum ? (
              <MessagesSquare size={24} className="channel-header-icon" />
            ) : (
              <Hash size={24} className="channel-header-icon" />
            )}
            <h1 className="channel-header-name">{channel.name}</h1>
            {channel.topic && (
              <>
                <span className="channel-header-divider" />
                <button type="button" className="channel-header-topic" title={channel.topic} aria-haspopup="dialog" aria-label={`Channel topic: ${channel.topic.length > 120 ? `${channel.topic.slice(0, 120)}...` : channel.topic}`} onClick={() => openModal({ type: "channelTopic", channelId: channel.id })}>
                  {channel.topic}
                </button>
              </>
            )}
          </>
        ) : (
          <>
            {oneToOne ? <Avatar user={first} size={24} status /> : <Users size={24} className="channel-header-icon" />}
            <h1 className="channel-header-name">{dmName(channel)}</h1>
          </>
        )}
      </div>
      <div className="channel-header-toolbar">
        {guild ? (
          <>
            {voice ? (
              <ToolbarButton label={chatOpen ? "Hide Chat" : "Show Chat"} active={chatOpen} onClick={() => useVoiceUi.getState().setChatOpen(!chatOpen)}>
                <MessageCircle size={24} />
              </ToolbarButton>
            ) : (
              <ThreadsToolbar channel={channel} />
            )}
            <ToolbarButton label="Notification Settings" onClick={bell}>
              <Bell size={24} />
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
          <ToolbarButton label="Pinned Messages" active={pinsOpen} onClick={() => setPinsOpen(o => !o)} buttonRef={setPinsAnchor}>
            <Pin size={24} />
          </ToolbarButton>
        )}
        {!guild && (
          <ToolbarButton label="Add Friends to DM" onClick={() => openModal({ type: "createDM", base: (channel.recipients ?? []).map(r => r.id) })}>
            <UserPlus size={24} />
          </ToolbarButton>
        )}
        {guild && !voice && (
          <ToolbarButton label={membersOpen ? "Hide Member List" : "Show Member List"} active={membersOpen} onClick={onToggleMembers}>
            <Users size={24} />
          </ToolbarButton>
        )}
        {oneToOne && (
          <ToolbarButton label={profileOpen ? "Hide User Profile" : "Show User Profile"} active={profileOpen} onClick={onToggleProfile}>
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
      </div>
      <Popout anchor={pinsAnchor} open={pinsOpen} onClose={() => setPinsOpen(false)} side="bottom" align="end" gap={8} className="pins-popout-host">
        <PinnedMessages channelId={channel.id} onNavigate={closePins} />
      </Popout>
    </header>
  );
}
