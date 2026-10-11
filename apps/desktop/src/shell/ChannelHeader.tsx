import { useEffect, useState, type ComponentType } from "react";
import { AtSign, Bell, Hash, MessageSquareText, Pin, Search, Users, Volume2 } from "lucide-react";
import { request } from "../api/rest";
import { dmName, displayName, useStore } from "../api/store";
import { ChannelType, type Channel, type Message } from "../api/types";
import { Popout, Tooltip } from "../ui";
import { Avatar } from "./Avatar";

// vokko-chat ships `PinnedMessages({ channelId })`; picked up here once it exists, with a plain fallback until then.
const chatModules = import.meta.glob<{ PinnedMessages?: ComponentType<{ channelId: string }> }>("../chat/PinnedMessages.tsx", { eager: true });
const ChatPins = Object.values(chatModules)[0]?.PinnedMessages;

function FallbackPins({ channelId }: { channelId: string }) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  useEffect(() => {
    let live = true;
    request<Message[]>("GET", `/channels/${channelId}/pins`)
      .then(list => live && setMessages(list))
      .catch(() => live && setMessages([]));
    return () => {
      live = false;
    };
  }, [channelId]);
  return (
    <div className="pins-popout">
      <div className="pins-header">Pinned Messages</div>
      <div className="pins-list">
        {messages === null && <div className="pins-empty">Loading…</div>}
        {messages?.length === 0 && <div className="pins-empty">This channel doesn&apos;t have any pinned messages… yet.</div>}
        {messages?.map(m => (
          <div key={m.id} className="pins-item">
            <div className="pins-author">{displayName(m.author, m.member)}</div>
            <div className="pins-content">{m.content}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolbarButton({ label, active, onClick, children, buttonRef }: { label: string; active?: boolean; onClick?: () => void; children: React.ReactNode; buttonRef?: (el: HTMLButtonElement | null) => void }) {
  return (
    <Tooltip content={label} side="bottom">
      <button ref={buttonRef} type="button" className={`toolbar-button${active ? " active" : ""}`} aria-label={label} aria-pressed={active} onClick={onClick}>
        {children}
      </button>
    </Tooltip>
  );
}

export interface ChannelHeaderProps {
  channel: Channel;
  membersOpen: boolean;
  onToggleMembers(): void;
}

/** 48 px header above the message area: channel/DM identity on the left, toolbar on the right. */
export function ChannelHeader({ channel, membersOpen, onToggleMembers }: ChannelHeaderProps) {
  const [pinsAnchor, setPinsAnchor] = useState<HTMLElement | null>(null);
  const [pinsOpen, setPinsOpen] = useState(false);
  const guild = !!channel.guild_id;
  const voice = channel.type === ChannelType.GuildVoice;
  const first = channel.recipients?.[0];
  const group = channel.type === ChannelType.GroupDM;
  const Pins = ChatPins ?? FallbackPins;
  const status = useStore(s => (first && !group ? s.presences[first.id]?.status : undefined));

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
            {first && !group ? <AtSign size={24} className="channel-header-icon" /> : <Users size={24} className="channel-header-icon" />}
            {first && !group && <Avatar user={first} size={24} status />}
            <h1 className="channel-header-name">{dmName(channel)}</h1>
            {status && status !== "offline" && <span className="channel-header-sub">{status === "dnd" ? "Do Not Disturb" : status === "idle" ? "Idle" : "Online"}</span>}
          </>
        )}
      </div>
      <div className="channel-header-toolbar">
        {guild && (
          <ToolbarButton label="Threads">
            <MessageSquareText size={24} />
          </ToolbarButton>
        )}
        <ToolbarButton label="Notification Settings">
          <Bell size={24} />
        </ToolbarButton>
        <ToolbarButton label="Pinned Messages" active={pinsOpen} onClick={() => setPinsOpen(o => !o)} buttonRef={setPinsAnchor}>
          <Pin size={24} />
        </ToolbarButton>
        {guild && (
          <ToolbarButton label={membersOpen ? "Hide Member List" : "Show Member List"} active={membersOpen} onClick={onToggleMembers}>
            <Users size={24} />
          </ToolbarButton>
        )}
        <div className="header-search">
          <input className="header-search-input" placeholder="Search" aria-label="Search" />
          <Search size={16} />
        </div>
      </div>
      <Popout anchor={pinsAnchor} open={pinsOpen} onClose={() => setPinsOpen(false)} side="bottom" align="end" gap={8} className="pins-popout-host">
        <Pins channelId={channel.id} />
      </Popout>
    </header>
  );
}
