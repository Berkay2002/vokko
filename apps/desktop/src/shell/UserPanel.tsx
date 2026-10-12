import { useEffect, useRef, useState } from "react";
import { ChevronDown, Headphones, HeadphoneOff, Inbox, Mic, MicOff, Monitor, Settings, Volume2 } from "lucide-react";
import { displayName, useStore } from "../api/store";
import { Tooltip, useContextMenu } from "../ui";
import { Avatar } from "./Avatar";
import { loadStoredStatus, setOwnStatus, type SelectableStatus } from "./actions";
import { InboxPopout } from "./Inbox";
import { closeModal, openModal, useModals } from "./modalStore";
import { NARROW_QUERY } from "./navDrawer";
import { useMediaQuery } from "./useMediaQuery";
import { UserPanelPopout } from "./UserPanelPopout";
import { toggleSelfDeaf, toggleSelfMute, useDeviceMenus, useVoice } from "../voice";

const LABEL: Record<string, string> = { online: "Online", idle: "Idle", dnd: "Do Not Disturb", offline: "Invisible" };

function DeviceChevron({ label, onOpen }: { label: string; onOpen: (rect: DOMRect) => void }) {
  return (
    <Tooltip content={label} side="top">
      <button type="button" className="user-panel-chevron" aria-label={label} aria-haspopup="menu" onClick={e => onOpen(e.currentTarget.getBoundingClientRect())}>
        <ChevronDown size={14} />
      </button>
    </Tooltip>
  );
}

export function UserPanel() {
  const me = useStore(s => s.me);
  const ready = useStore(s => s.ready);
  const presence = useStore(s => (s.me ? s.presences[s.me.id] : undefined));
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [inboxAnchor, setInboxAnchor] = useState<HTMLElement | null>(null);
  const inboxModal = useModals(s => s.modal?.type === "inbox");
  const narrow = useMediaQuery(NARROW_QUERY);
  const inboxOpen = inboxModal && narrow;
  const muted = useVoice(s => s.selfMute);
  const deafened = useVoice(s => s.selfDeaf);
  const stored = useRef(loadStoredStatus());
  const [custom, setCustom] = useState(stored.current.custom);
  const [selected, setSelected] = useState<SelectableStatus>(stored.current.status);
  const menu = useContextMenu();
  const inVoice = useVoice(s => s.meId !== null && s.states[s.meId]?.channel_id != null);
  const sharing = useVoice(s => s.meId !== null && !!s.states[s.meId]?.self_stream);
  const { micItems, headphoneItems } = useDeviceMenus();

  // Re-apply the user's chosen status after every (re)identify: the server starts a session as "online".
  useEffect(() => {
    if (!ready) return;
    const { status, custom: text } = loadStoredStatus();
    if (status !== "online" || text) setOwnStatus(status, text);
  }, [ready]);

  // The status note can also be set from the profile editor: follow the presence the gateway reports for the user.
  // Until the gateway has reported a presence (or echoed the note re-applied after identify) the stored note stays.
  const known = !!presence;
  const reported = presence?.custom_status ?? "";
  useEffect(() => {
    if (!known || (reported === "" && loadStoredStatus().custom !== "")) return;
    setCustom(reported);
  }, [known, reported]);

  if (!me) return null;
  const status = presence?.status ?? "online";
  const subtitle = presence?.custom_status || LABEL[status] || "Online";

  const choose = (value: SelectableStatus) => {
    setSelected(value);
    setOwnStatus(value, custom);
    setOpen(false);
  };

  return (
    <section className="user-panel" aria-label="User status and settings">
      <button ref={setAnchor} type="button" className={`user-panel-account${open ? " active" : ""}${inVoice ? " in-voice" : ""}`} onClick={() => setOpen(o => !o)} aria-haspopup="dialog" aria-expanded={open}>
        <Avatar user={me} size={32} status />
        <span className="user-panel-names">
          <span className="user-panel-name-row">
            <span className="user-panel-name">{displayName(me)}</span>
            <ChevronDown size={16} className="user-panel-name-chevron" aria-hidden="true" />
          </span>
          <span className="user-panel-sub">
            <span className="user-panel-sub-status">
              {inVoice && sharing && <Monitor size={12} className="user-panel-voice-icon user-panel-stream-icon" aria-hidden="true" />}
              {inVoice && !sharing && <Volume2 size={12} className="user-panel-voice-icon" aria-hidden="true" />}
              {inVoice ? (sharing ? "Sharing Your Screen" : "In voice channel") : subtitle}
            </span>
            <span className="user-panel-sub-username personal-info">{me.username}</span>
          </span>
        </span>
      </button>
      <div className="user-panel-buttons">
        <div className="user-panel-split">
          <Tooltip content={muted ? "Unmute" : "Mute"} side="top">
            <button type="button" className={`user-panel-button${muted ? " muted" : ""}`} aria-pressed={muted} aria-label={muted ? "Unmute" : "Mute"} onClick={toggleSelfMute}>
              {muted ? <MicOff size={20} /> : <Mic size={20} />}
            </button>
          </Tooltip>
          <DeviceChevron label="Input Options" onOpen={rect => menu.open({ clientX: rect.left, clientY: rect.top }, micItems())} />
        </div>
        <div className="user-panel-split">
          <Tooltip content={deafened ? "Undeafen" : "Deafen"} side="top">
            <button type="button" className={`user-panel-button${deafened ? " muted" : ""}`} aria-pressed={deafened} aria-label={deafened ? "Undeafen" : "Deafen"} onClick={toggleSelfDeaf}>
              {deafened ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
            </button>
          </Tooltip>
          <DeviceChevron label="Output Options" onOpen={rect => menu.open({ clientX: rect.left, clientY: rect.top }, headphoneItems())} />
        </div>
        <button ref={setInboxAnchor} type="button" className="user-panel-button user-panel-inbox" aria-label="Inbox" aria-expanded={inboxOpen} onClick={() => (inboxOpen ? closeModal() : openModal({ type: "inbox" }))}>
          <Inbox size={20} />
        </button>
        <Tooltip content="User Settings" side="top">
          <button type="button" className="user-panel-button" aria-label="User Settings" onClick={() => openModal({ type: "userSettings" })}>
            <Settings size={20} />
          </button>
        </Tooltip>
      </div>
      <InboxPopout anchor={inboxAnchor} open={inboxOpen} />
      <UserPanelPopout
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        status={selected}
        onStatus={choose}
        custom={custom}
        onCustom={setCustom}
        onSubmitCustom={() => {
          setOwnStatus(selected, custom);
          setOpen(false);
        }}
        inVoice={inVoice}
      />
    </section>
  );
}
