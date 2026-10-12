import { useState } from "react";
import { CircleHelp, Hash, Inbox, Users, Volume2 } from "lucide-react";
import { dmName, useStore } from "../api/store";
import { ChannelType } from "../api/types";
import { Tooltip } from "../ui";
import { InboxPopout } from "./Inbox";
import { closeModal, openModal, useModals } from "./modalStore";
import { NARROW_QUERY } from "./navDrawer";
import { useMediaQuery } from "./useMediaQuery";
import { useRegisterTitleBar, WindowControls } from "./WindowControls";

/** The 32 px title bar: current page title centred, Inbox and Help on the right, and in the desktop app (off macOS) the window buttons after them and a drag region over the whole bar. Help opens the keybinds page, the only shortcut list we have. */
export function TitleBar() {
  const [inboxButton, setInboxButton] = useState<HTMLElement | null>(null);
  useRegisterTitleBar();
  const inboxOpen = useModals(s => s.modal?.type === "inbox");
  // the phone has no title bar: the user card on the list page opens the Inbox
  const narrow = useMediaQuery(NARROW_QUERY);
  const title = useStore(s => {
    const channel = s.route.channelId ? s.channels[s.route.channelId] : undefined;
    if (!channel) return { icon: "friends" as const, text: s.route.guildId ? (s.guilds[s.route.guildId]?.name ?? "") : "Friends" };
    if (channel.guild_id) return { icon: channel.type === ChannelType.GuildVoice ? ("voice" as const) : ("hash" as const), text: channel.name ?? "" };
    return { icon: "dm" as const, text: dmName(channel) };
  });
  return (
    <header className="title-bar" data-tauri-drag-region="deep">
      <div className="title-bar-title">
        {title.icon === "friends" && <Users size={18} />}
        {title.icon === "hash" && <Hash size={18} />}
        {title.icon === "voice" && <Volume2 size={18} />}
        <span>{title.text}</span>
      </div>
      <div className="title-bar-actions">
        <Tooltip content="Inbox" side="bottom">
          <button ref={setInboxButton} type="button" className={`title-bar-button${inboxOpen ? " active" : ""}`} aria-label="Inbox" aria-expanded={inboxOpen} onClick={() => (inboxOpen ? closeModal() : openModal({ type: "inbox" }))}>
            <Inbox size={18} />
          </button>
        </Tooltip>
        <Tooltip content="Help" side="bottom">
          <button type="button" className="title-bar-button" aria-label="Help" onClick={() => openModal({ type: "userSettings", section: "keybinds" })}>
            <CircleHelp size={18} />
          </button>
        </Tooltip>
      </div>
      <WindowControls />
      <InboxPopout anchor={inboxButton} open={inboxOpen && !narrow} />
    </header>
  );
}
