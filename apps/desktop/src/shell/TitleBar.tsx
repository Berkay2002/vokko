import { CircleHelp, Hash, Inbox, Users, Volume2 } from "lucide-react";
import { dmName, useStore } from "../api/store";
import { ChannelType } from "../api/types";
import { Tooltip } from "../ui";

/** The 32 px web title bar: current page title centred, Inbox and Help on the right (desktop builds draw native chrome instead). */
export function TitleBar() {
  const title = useStore(s => {
    const channel = s.route.channelId ? s.channels[s.route.channelId] : undefined;
    if (!channel) return { icon: "friends" as const, text: s.route.guildId ? (s.guilds[s.route.guildId]?.name ?? "") : "Friends" };
    if (channel.guild_id) return { icon: channel.type === ChannelType.GuildVoice ? ("voice" as const) : ("hash" as const), text: channel.name ?? "" };
    return { icon: "dm" as const, text: dmName(channel) };
  });
  return (
    <header className="title-bar">
      <div className="title-bar-title">
        {title.icon === "friends" && <Users size={16} />}
        {title.icon === "hash" && <Hash size={16} />}
        {title.icon === "voice" && <Volume2 size={16} />}
        <span>{title.text}</span>
      </div>
      <div className="title-bar-actions">
        <Tooltip content="Inbox" side="bottom">
          <button type="button" className="title-bar-button" aria-label="Inbox">
            <Inbox size={18} />
          </button>
        </Tooltip>
        <Tooltip content="Help" side="bottom">
          <button type="button" className="title-bar-button" aria-label="Help">
            <CircleHelp size={18} />
          </button>
        </Tooltip>
      </div>
    </header>
  );
}
