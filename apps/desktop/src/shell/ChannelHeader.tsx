import { useState } from "react";
import { Bell, Hash, MessageSquareText, Phone, Pin, Search, UserPlus, UserRound, Users, Video, Volume2 } from "lucide-react";
import { dmName } from "../api/store";
import { ChannelType, type Channel } from "../api/types";
import { PinnedMessages } from "../chat/PinnedMessages";
import { Popout, Tooltip, useContextMenu } from "../ui";
import { Avatar } from "./Avatar";
import { muteItem, notificationItem, UNAVAILABLE } from "./menus";
import { openModal } from "./modalStore";

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
  const menu = useContextMenu();
  const guild = !!channel.guild_id;
  const voice = channel.type === ChannelType.GuildVoice;
  const first = channel.recipients?.[0];
  const group = channel.type === ChannelType.GroupDM;
  const oneToOne = !guild && !group && !!first;

  const bell = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    menu.open({ clientX: rect.left, clientY: rect.bottom + 4 }, [muteItem(channel.id, group ? "Conversation" : "Channel"), notificationItem(channel.id)]);
  };

  return (
    <header className="channel-header">
      <div className="channel-header-title">
        {guild ? (
          <>
            {voice ? <Volume2 size={24} className="channel-header-icon" /> : <Hash size={24} className="channel-header-icon" />}
            <h1 className="channel-header-name">{channel.name}</h1>
            {channel.topic && (
              <>
                <span className="channel-header-divider" />
                <span className="channel-header-topic" title={channel.topic}>
                  {channel.topic}
                </span>
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
            <ToolbarButton label="Threads" disabled>
              <MessageSquareText size={24} />
            </ToolbarButton>
            <ToolbarButton label="Notification Settings" onClick={bell}>
              <Bell size={24} />
            </ToolbarButton>
          </>
        ) : (
          <>
            <ToolbarButton label="Start Voice Call" disabled>
              <Phone size={24} />
            </ToolbarButton>
            <ToolbarButton label="Start Video Call" disabled>
              <Video size={24} />
            </ToolbarButton>
          </>
        )}
        <ToolbarButton label="Pinned Messages" active={pinsOpen} onClick={() => setPinsOpen(o => !o)} buttonRef={setPinsAnchor}>
          <Pin size={24} />
        </ToolbarButton>
        {!guild && (
          <ToolbarButton label="Add Friends to DM" onClick={() => openModal({ type: "createDM", base: (channel.recipients ?? []).map(r => r.id) })}>
            <UserPlus size={24} />
          </ToolbarButton>
        )}
        {guild && (
          <ToolbarButton label={membersOpen ? "Hide Member List" : "Show Member List"} active={membersOpen} onClick={onToggleMembers}>
            <Users size={24} />
          </ToolbarButton>
        )}
        {oneToOne && (
          <ToolbarButton label={profileOpen ? "Hide User Profile" : "Show User Profile"} active={profileOpen} onClick={onToggleProfile}>
            <UserRound size={24} />
          </ToolbarButton>
        )}
        <div className="header-search">
          <input className="header-search-input" placeholder={"Search"} aria-label="Search" />
          <Search size={16} />
        </div>
      </div>
      <Popout anchor={pinsAnchor} open={pinsOpen} onClose={() => setPinsOpen(false)} side="bottom" align="end" gap={8} className="pins-popout-host">
        <PinnedMessages channelId={channel.id} />
      </Popout>
    </header>
  );
}
