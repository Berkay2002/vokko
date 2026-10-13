import { useState } from "react";
import { ArrowLeft, ArrowRight, CircleHelp, Hash, Inbox, Users, Volume2 } from "lucide-react";
import { useLocation, useNavigate, useNavigationType } from "react-router";
import { useWindowChrome } from "../desktop/windowControls";
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
      <HistoryArrows />
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

// The furthest history entry reached, so Forward knows whether there is anything ahead (the History API does not say).
let furthest = 0;

/** Back and forward through the app's history, top left like Discord's desktop app. Only where the page draws the window chrome
 * (Windows, Linux): a browser has its own buttons, and on macOS the traffic lights sit there. */
function HistoryArrows() {
  const chrome = useWindowChrome();
  const navigate = useNavigate();
  const type = useNavigationType();
  useLocation(); // re-render on every navigation
  // BrowserRouter stores the entry's position in history.state.idx
  const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
  if (type === "PUSH" || idx > furthest) furthest = idx;
  if (chrome?.customControls !== true) return null;
  return (
    <div className="title-bar-history">
      <button type="button" className="title-bar-button" aria-label="Back" disabled={idx <= 0} onClick={() => void navigate(-1)}>
        <ArrowLeft size={18} />
      </button>
      <button type="button" className="title-bar-button" aria-label="Forward" disabled={idx >= furthest} onClick={() => void navigate(1)}>
        <ArrowRight size={18} />
      </button>
    </div>
  );
}
