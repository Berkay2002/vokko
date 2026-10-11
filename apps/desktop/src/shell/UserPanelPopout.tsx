import { ArrowLeftRight, ChevronRight, Copy, Pencil } from "lucide-react";
import { displayName, useStore } from "../api/store";
import { ProfileBanner } from "../perks/ProfileBanner";
import { resolveProfile, themeVars } from "../perks/profile";
import { TagChip } from "../perks/TagChip";
import { Popout, useContextMenu, type MenuItem } from "../ui";
import { Avatar, StatusBadge } from "./Avatar";
import { copyText, type SelectableStatus } from "./actions";
import { openModal } from "./modalStore";
import { InVoiceCard } from "../voice";

const OPTIONS: { value: SelectableStatus; label: string; hint?: string; badge: "online" | "idle" | "dnd" | "offline" }[] = [
  { value: "online", label: "Online", badge: "online" },
  { value: "idle", label: "Idle", badge: "idle" },
  { value: "dnd", label: "Do Not Disturb", hint: "You will not receive any desktop notifications.", badge: "dnd" },
  { value: "invisible", label: "Invisible", hint: "You will appear offline.", badge: "offline" },
];

export interface UserPanelPopoutProps {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  status: SelectableStatus;
  onStatus: (status: SelectableStatus) => void;
  custom: string;
  onCustom: (text: string) => void;
  /** Enter in the status note. */
  onSubmitCustom: () => void;
  /** Show the in-voice card (the user is connected to a voice channel). */
  inVoice?: boolean;
}

/** Popout above the user panel: own profile card (banner, avatar, status note, names) over the account rows. */
export function UserPanelPopout({ anchor, open, onClose, status, onStatus, custom, onCustom, onSubmitCustom, inVoice }: UserPanelPopoutProps) {
  const me = useStore(s => s.me);
  const tagGuildName = useStore(s => (s.me?.primary_guild ? s.guilds[s.me.primary_guild.guild_id]?.name : undefined));
  const menu = useContextMenu();
  if (!me) return null;
  const look = resolveProfile(me);
  const current = OPTIONS.find(o => o.value === status) ?? OPTIONS[0];

  const submenu = (event: React.MouseEvent<HTMLElement>, items: MenuItem[]) => {
    const rect = event.currentTarget.getBoundingClientRect();
    menu.open({ clientX: rect.right + 4, clientY: rect.top }, items);
  };
  const statusItems: MenuItem[] = OPTIONS.map(o => ({
    id: `status-${o.value}`,
    label: o.label,
    icon: <StatusBadge status={o.badge} size={10} />,
    tooltip: o.hint,
    checked: o.value === status,
    onSelect: () => onStatus(o.value),
  }));
  const accountItems: MenuItem[] = [
    { id: "account-current", label: displayName(me), icon: <Avatar user={me} size={20} />, checked: true },
    { type: "separator" },
    { id: "account-logout", label: "Log Out", danger: true, onSelect: () => (onClose(), openModal({ type: "logout" })) },
  ];

  return (
    <Popout anchor={anchor} open={open} onClose={onClose} side="top" align="start" gap={8} role="dialog" label="User profile" className={`profile-card user-popout${look.themeColors ? " pv-themed" : ""}`} style={themeVars(look.themeColors)}>
      <ProfileBanner look={look} className="profile-banner" />
      <div className="profile-avatar">
        <Avatar user={me} size={80} status />
      </div>
      <form
        className="user-popout-note"
        onSubmit={e => {
          e.preventDefault();
          onSubmitCustom();
        }}
      >
        <input value={custom} maxLength={128} placeholder="Add a status" aria-label="Custom status" onChange={e => onCustom(e.target.value)} />
      </form>
      <div className="profile-body">
        <div className="profile-name">{displayName(me)}</div>
        <div className="pv-name-row">
          <span className="profile-username">{me.username}</span>
          <TagChip tag={me.primary_guild} guildName={tagGuildName} />
        </div>
        {look.pronouns && <div className="pv-pronouns">{look.pronouns}</div>}
      </div>
      {inVoice && <InVoiceCard userId={me.id} onOpen={onClose} />}
      <div className="user-popout-menu" role="menu">
        <div className="user-popout-card" role="group">
          <button type="button" role="menuitem" className="user-popout-row" onClick={() => (onClose(), openModal({ type: "userSettings", section: "profiles" }))}>
            <Pencil size={20} />
            <span>Edit Profile</span>
          </button>
          <button type="button" role="menuitem" className="user-popout-row" aria-haspopup="menu" onClick={e => submenu(e, statusItems)}>
            <StatusBadge status={current.badge} size={10} />
            <span>{current.label}</span>
            <ChevronRight size={16} className="user-popout-chevron" />
          </button>
        </div>
        <div className="user-popout-card" role="group">
          <button type="button" role="menuitem" className="user-popout-row" aria-haspopup="menu" onClick={e => submenu(e, accountItems)}>
            <ArrowLeftRight size={20} />
            <span>Switch Accounts</span>
            <ChevronRight size={16} className="user-popout-chevron" />
          </button>
          <button type="button" role="menuitem" className="user-popout-row" onClick={() => (copyText(me.id), onClose())}>
            <Copy size={20} />
            <span>Copy User ID</span>
          </button>
        </div>
      </div>
    </Popout>
  );
}
