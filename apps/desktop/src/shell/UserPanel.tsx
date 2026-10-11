import { useEffect, useRef, useState } from "react";
import { Headphones, HeadphoneOff, Mic, MicOff, Settings } from "lucide-react";
import { displayName, useStore } from "../api/store";
import { Popout, Tooltip } from "../ui";
import { Avatar, StatusBadge } from "./Avatar";
import { loadStoredStatus, setOwnStatus, type SelectableStatus } from "./actions";
import { openModal } from "./modalStore";

const OPTIONS: { value: SelectableStatus; label: string; hint?: string; badge: "online" | "idle" | "dnd" | "offline" }[] = [
  { value: "online", label: "Online", badge: "online" },
  { value: "idle", label: "Idle", badge: "idle" },
  { value: "dnd", label: "Do Not Disturb", hint: "You will not receive any desktop notifications.", badge: "dnd" },
  { value: "invisible", label: "Invisible", hint: "You will appear offline.", badge: "offline" },
];

const LABEL: Record<string, string> = { online: "Online", idle: "Idle", dnd: "Do Not Disturb", offline: "Invisible" };

export function UserPanel() {
  const me = useStore(s => s.me);
  const ready = useStore(s => s.ready);
  const presence = useStore(s => (s.me ? s.presences[s.me.id] : undefined));
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const stored = useRef(loadStoredStatus());
  const [custom, setCustom] = useState(stored.current.custom);
  const [selected, setSelected] = useState<SelectableStatus>(stored.current.status);

  // Re-apply the user's chosen status after every (re)identify: the server starts a session as "online".
  useEffect(() => {
    if (!ready) return;
    const { status, custom: text } = loadStoredStatus();
    if (status !== "online" || text) setOwnStatus(status, text);
  }, [ready]);

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
      <button ref={setAnchor} type="button" className={`user-panel-account${open ? " active" : ""}`} onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open}>
        <Avatar user={me} size={32} status />
        <span className="user-panel-names">
          <span className="user-panel-name">{displayName(me)}</span>
          <span className="user-panel-sub">
            <span className="user-panel-sub-status">{subtitle}</span>
            <span className="user-panel-sub-username">{me.username}</span>
          </span>
        </span>
      </button>
      <div className="user-panel-buttons">
        <Tooltip content={muted ? "Unmute" : "Mute"} side="top">
          <button type="button" className={`user-panel-button${muted ? " muted" : ""}`} aria-pressed={muted} aria-label={muted ? "Unmute" : "Mute"} onClick={() => setMuted(m => !m)}>
            {muted ? <MicOff size={20} /> : <Mic size={20} />}
          </button>
        </Tooltip>
        <Tooltip content={deafened ? "Undeafen" : "Deafen"} side="top">
          <button type="button" className={`user-panel-button${deafened ? " muted" : ""}`} aria-pressed={deafened} aria-label={deafened ? "Undeafen" : "Deafen"} onClick={() => setDeafened(d => !d)}>
            {deafened ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
          </button>
        </Tooltip>
        <Tooltip content="User Settings" side="top">
          <button type="button" className="user-panel-button" aria-label="User Settings" onClick={() => openModal({ type: "userSettings" })}>
            <Settings size={20} />
          </button>
        </Tooltip>
      </div>
      <Popout anchor={anchor} open={open} onClose={() => setOpen(false)} side="top" align="start" gap={8} className="status-menu">
        <div className="status-menu-header">
          <Avatar user={me} size={32} status />
          <div className="status-menu-name">{displayName(me)}</div>
        </div>
        <div className="status-menu-list" role="menu">
          {OPTIONS.map(option => (
            <button key={option.value} type="button" role="menuitemradio" aria-checked={selected === option.value} className={`status-menu-item${selected === option.value ? " selected" : ""}`} onClick={() => choose(option.value)}>
              <StatusBadge status={option.badge} size={10} />
              <span className="status-menu-text">
                <span className="status-menu-label">{option.label}</span>
                {option.hint && <span className="status-menu-hint">{option.hint}</span>}
              </span>
            </button>
          ))}
        </div>
        <form
          className="status-menu-custom"
          onSubmit={e => {
            e.preventDefault();
            setOwnStatus(selected, custom);
            setOpen(false);
          }}
        >
          <input className="status-menu-input" value={custom} maxLength={128} placeholder="Set a custom status" onChange={e => setCustom(e.target.value)} />
        </form>
      </Popout>
    </section>
  );
}
