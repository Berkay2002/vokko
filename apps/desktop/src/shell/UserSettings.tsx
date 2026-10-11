import { useRef, useState } from "react";
import type { UIEvent } from "react";
import { Accessibility, Bell, Gamepad2, Keyboard, Languages, LogOut, Mic, MessagesSquare, Palette, Pencil, Plug, Search, ShieldCheck, User as UserIcon } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { request, uploadAttachment } from "../api/rest";
import { appStore, displayName, useStore } from "../api/store";
import type { User } from "../api/types";
import { Avatar } from "./Avatar";
import { closeModal, openModal } from "./modalStore";
import { AccessibilityPage } from "./settings/AccessibilityPage";
import { AppearancePage } from "./settings/AppearancePage";
import { Category, Page, Select, Unavailable } from "./settings/controls";
import { KeybindsPage } from "./settings/KeybindsPage";
import { NotificationsPage } from "./settings/NotificationsPage";
import { SettingsBlock, SettingsModal, SettingsNavGroup, SettingsNavItem, SettingsNavSub, SettingsNavSubs, SettingsRow } from "./settings/SettingsModal";
import { VoiceVideoPage } from "./settings/VoiceVideoPage";

type NavIcon = typeof UserIcon;

interface SectionDef {
  id: string;
  label: string;
  icon: NavIcon;
  /** Group heading; "" renders no heading (Discord hides the General title). */
  group: string;
  /** Not listed in the sidebar: reached from the profile header. */
  hidden?: boolean;
  /** Category headings shown on pages that are not implemented, in Discord's order. */
  outline?: string[];
}

// Order and grouping follow Discord's User Settings sidebar (research/discord-ui-inventory.md S1, settings-modal reference).
// The Billing group (Nitro, Server Boost, Subscriptions, Gift Inventory, Billing) and the desktop-only game pages are left out on purpose.
const SECTIONS: SectionDef[] = [
  { id: "account", label: "My Account", icon: UserIcon, group: "", outline: ["Account Info", "Password & Security", "Account Status"] },
  { id: "privacy", label: "Data & Privacy", icon: ShieldCheck, group: "", outline: ["How Vokko Uses My Data", "Profile Privacy"] },
  { id: "content", label: "Content & Social", icon: MessagesSquare, group: "", outline: ["Content Filters", "Spam Filters", "Direct Message (DM) Permissions", "Friend Request Permissions", "Ignore & Block"] },
  { id: "notifications", label: "Notifications", icon: Bell, group: "" },
  { id: "voice", label: "Voice & Video", icon: Mic, group: "Experience" },
  { id: "appearance", label: "Appearance", icon: Palette, group: "Experience" },
  { id: "accessibility", label: "Accessibility", icon: Accessibility, group: "Experience" },
  { id: "keybinds", label: "Keybinds", icon: Keyboard, group: "Experience" },
  { id: "language", label: "Language & Time", icon: Languages, group: "Experience" },
  { id: "activity", label: "Activity Privacy", icon: Gamepad2, group: "Games & Apps", outline: ["What Activity I Share", "Where I Share Activity"] },
  { id: "connections", label: "Connected Apps", icon: Plug, group: "Games & Apps", outline: ["Connections", "Authorized Apps"] },
  { id: "profiles", label: "Profiles", icon: UserIcon, group: "", hidden: true },
];

/** The sub-items of My Account: sections of one scrolling page. Family Center is not offered. */
const ACCOUNT_ANCHORS = [
  { id: "info", label: "Account Info" },
  { id: "security", label: "Password & Security" },
  { id: "status", label: "Account Status" },
];

function NotYet({ section }: { section: SectionDef }) {
  return (
    <Page title={section.label}>
      <Unavailable>This section is not available yet.</Unavailable>
      {section.outline?.map(title => (
        <Category key={title} title={title}>
          <p className="settings-todo">Not available yet.</p>
        </Category>
      ))}
    </Page>
  );
}

function LanguageTime() {
  return (
    <Page title="Language & Time">
      <Category title="Select a Language">
        <Select<string> label="Language" value="en" options={[{ value: "en", label: "English" }]} onChange={() => undefined} />
        <p className="settings-todo">More languages are not available yet.</p>
      </Category>
    </Page>
  );
}

const BANNER_COLORS = ["#5865f2", "#3d9e60", "#ffcb6e", "#dc4247", "#c45bd0", "#2b8fb5", "#6d7380", "#1e1f22"];

function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "Something went wrong. Try again.";
}

function useSave() {
  const [state, setState] = useState<{ busy: boolean; error: string | null; saved: boolean }>({ busy: false, error: null, saved: false });
  const save = async (patch: Record<string, unknown>) => {
    setState({ busy: true, error: null, saved: false });
    try {
      const user = await request<User>("PATCH", "/users/@me", patch);
      appStore.getState().setMe(user);
      appStore.getState().cacheUsers([user]);
      setState({ busy: false, error: null, saved: true });
      return true;
    } catch (error) {
      setState({ busy: false, error: errorText(error), saved: false });
      return false;
    }
  };
  return { ...state, save };
}

function MyAccount({ me }: { me: User }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(me.global_name ?? "");
  const { busy, error, saved, save } = useSave();
  const unchanged = name.trim() === (me.global_name ?? "");
  const submit = async () => {
    if (await save({ global_name: name.trim() })) setEditing(false);
  };
  return (
    <>
      <SettingsBlock anchor="info" title="Account Info">
        {editing ? (
          <SettingsRow label="Display Name">
            <input
              className="input sm-row-input"
              aria-label="Display Name"
              value={name}
              maxLength={32}
              placeholder={me.username}
              autoFocus
              onChange={e => setName(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !unchanged && !busy) void submit();
              }}
            />
            <button type="button" className="sm-btn" onClick={() => { setEditing(false); setName(me.global_name ?? ""); }}>
              Cancel
            </button>
            <button type="button" className="sm-btn primary" disabled={busy || unchanged} onClick={() => void submit()}>
              Save
            </button>
          </SettingsRow>
        ) : (
          <SettingsRow label="Display Name" value={displayName(me)}>
            <button type="button" className="sm-btn" onClick={() => setEditing(true)}>
              Edit
            </button>
          </SettingsRow>
        )}
        {error && <p className="field-error">{error}</p>}
        {saved && !editing && <p className="settings-saved">Saved.</p>}
        <SettingsRow label="Username" value={me.username}>
          <button type="button" className="sm-btn" disabled title="Not available yet">
            Edit
          </button>
        </SettingsRow>
      </SettingsBlock>
      <SettingsBlock anchor="security" title="Password & Security">
        <SettingsRow label="Password" value={<span className="sm-muted">Not available yet</span>}>
          <button type="button" className="sm-btn" disabled title="Not available yet">
            Change
          </button>
        </SettingsRow>
        <SettingsRow label="Logged-in Devices" value={<span className="sm-muted">Not available yet</span>} />
      </SettingsBlock>
      <SettingsBlock anchor="status" title="Account Status">
        <SettingsRow label="Disable Account" value={<span className="sm-muted">Not available yet</span>}>
          <button type="button" className="sm-btn" disabled title="Not available yet">
            Disable
          </button>
        </SettingsRow>
        <SettingsRow label="Delete Account" value={<span className="sm-muted">Not available yet</span>}>
          <button type="button" className="sm-btn" disabled title="Not available yet">
            Delete
          </button>
        </SettingsRow>
      </SettingsBlock>
    </>
  );
}

function Profiles({ me }: { me: User }) {
  const [bio, setBio] = useState(me.bio ?? "");
  const [color, setColor] = useState(me.banner_color ?? "#5865f2");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const uploadChannel = useStore(s => s.privateChannels[0] ?? Object.values(s.channels).find(c => c.guild_id)?.id);
  const { busy, error, saved, save } = useSave();
  const dirty = bio.trim() !== (me.bio ?? "") || color !== (me.banner_color ?? "#5865f2");

  const pick = async (selected: File | undefined) => {
    if (!selected || !uploadChannel) return;
    setUploading(true);
    setUploadError(null);
    try {
      const attachment = await uploadAttachment(uploadChannel, selected);
      await save({ avatar_attachment_id: attachment.id });
    } catch (e) {
      setUploadError(errorText(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="settings-page profiles-page">
      <div className="profiles-layout">
        <div className="profiles-form">
          <div className="field-label">Avatar</div>
          <div className="account-inline">
            <button type="button" className="btn btn-primary btn-sm" disabled={uploading || !uploadChannel} onClick={() => file.current?.click()}>
              {uploading ? "Uploading…" : "Change Avatar"}
            </button>
            <button type="button" className="btn btn-link btn-sm" disabled={busy || !me.avatar} onClick={() => void save({ avatar_attachment_id: null })}>
              Remove Avatar
            </button>
            <input ref={file} type="file" accept="image/*" hidden onChange={e => void pick(e.target.files?.[0])} />
          </div>
          {uploadError && <p className="field-error">{uploadError}</p>}
          <div className="field-label">Banner Color</div>
          <div className="swatches">
            {BANNER_COLORS.map(c => (
              <button key={c} type="button" className={`swatch${color === c ? " selected" : ""}`} style={{ background: c }} aria-label={c} onClick={() => setColor(c)} />
            ))}
          </div>
          <label className="field-label" htmlFor="bio">
            About Me
          </label>
          <textarea id="bio" className="input textarea" rows={4} maxLength={190} value={bio} onChange={e => setBio(e.target.value)} />
          <div className="char-count">{190 - bio.length}</div>
          <div className="account-inline">
            <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={() => void save({ bio: bio.trim(), banner_color: color })}>
              Save Changes
            </button>
            {saved && <span className="settings-saved">Saved.</span>}
          </div>
          {error && <p className="field-error">{error}</p>}
        </div>
        <div className="profile-preview">
          <div className="field-label">Preview</div>
          <div className="profile-card static">
            <div className="profile-banner" style={{ background: color }} />
            <div className="profile-avatar">
              <Avatar user={me} size={80} />
            </div>
            <div className="profile-body">
              <div className="profile-name">{displayName(me)}</div>
              <div className="profile-username">{me.username}</div>
              {bio.trim() && (
                <section className="profile-section">
                  <h3>About Me</h3>
                  <p>{bio}</p>
                </section>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function UserSettings({ section }: { section?: string }) {
  const me = useStore(s => s.me);
  const [current, setCurrent] = useState(SECTIONS.some(s => s.id === section) ? (section as string) : "account");
  const [anchor, setAnchor] = useState(ACCOUNT_ANCHORS[0]!.id);
  const [query, setQuery] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  if (!me) return null;

  const needle = query.trim().toLowerCase();
  const visible = SECTIONS.filter(s => !s.hidden && (!needle || s.label.toLowerCase().includes(needle) || (s.outline ?? []).some(o => o.toLowerCase().includes(needle))));
  const groups = [...new Set(visible.map(s => s.group))];
  const active = SECTIONS.find(s => s.id === current) ?? SECTIONS[0]!;

  const open = (id: string) => {
    setCurrent(id);
    setAnchor(ACCOUNT_ANCHORS[0]!.id);
    scroller.current?.scrollTo({ top: 0, behavior: "instant" });
  };

  const scrollToAnchor = (id: string) => {
    const box = scroller.current;
    const title = box?.querySelector<HTMLElement>(`[data-anchor="${id}"] .sm-block-title`);
    if (!box || !title) return;
    setAnchor(id);
    box.scrollTo({ top: Math.max(0, title.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 40) });
  };

  // the sub-item whose heading last passed the top of the page is the current one
  const trackAnchor = (event: UIEvent<HTMLDivElement>) => {
    if (current !== "account") return;
    const box = event.currentTarget;
    const top = box.getBoundingClientRect().top;
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
    let found = ACCOUNT_ANCHORS[0]!.id;
    for (const a of ACCOUNT_ANCHORS) {
      const title = box.querySelector<HTMLElement>(`[data-anchor="${a.id}"] .sm-block-title`);
      if (title && title.getBoundingClientRect().top - top <= 80) found = a.id;
    }
    if (atEnd && box.scrollTop > 0) found = ACCOUNT_ANCHORS[ACCOUNT_ANCHORS.length - 1]!.id;
    setAnchor(found);
  };

  const page = () => {
    switch (current) {
      case "account":
        return <MyAccount me={me} />;
      case "profiles":
        return <Profiles me={me} />;
      case "notifications":
        return <NotificationsPage />;
      case "voice":
        return <VoiceVideoPage />;
      case "appearance":
        return <AppearancePage />;
      case "accessibility":
        return <AccessibilityPage />;
      case "keybinds":
        return <KeybindsPage />;
      case "language":
        return <LanguageTime />;
      default:
        return <NotYet section={active} />;
    }
  };

  const side = (
    <>
      <div className="sm-profile">
        <Avatar user={me} size={48} />
        <div className="sm-profile-names">
          <div className="sm-profile-name">{displayName(me)}</div>
          <button type="button" className="sm-profile-edit" onClick={() => open("profiles")}>
            Edit Profiles
            <Pencil size={14} />
          </button>
        </div>
      </div>
      <label className="sm-search">
        <Search size={18} />
        <input type="search" placeholder="Search" aria-label="Search settings" value={query} onChange={e => setQuery(e.target.value)} />
      </label>
      {groups.map(group => (
        <SettingsNavGroup key={group || "top"} title={group}>
          {visible
            .filter(s => s.group === group)
            .map(s => (
              <div key={s.id}>
                <SettingsNavItem icon={s.icon} label={s.label} selected={current === s.id} expanded={s.id === "account" ? current === "account" : undefined} onClick={() => open(s.id)} />
                {s.id === "account" && current === "account" && (
                  <SettingsNavSubs>
                    {ACCOUNT_ANCHORS.map(a => (
                      <SettingsNavSub key={a.id} label={a.label} active={anchor === a.id} onClick={() => scrollToAnchor(a.id)} />
                    ))}
                  </SettingsNavSubs>
                )}
              </div>
            ))}
        </SettingsNavGroup>
      ))}
      <SettingsNavGroup>
        <SettingsNavItem icon={LogOut} label="Log Out" danger onClick={() => openModal({ type: "logout" })} />
      </SettingsNavGroup>
    </>
  );

  return (
    <SettingsModal label="User Settings" title={active.label} side={side} onClose={closeModal} pageKey={current} scrollRef={scroller} onScroll={trackAnchor}>
      {page()}
    </SettingsModal>
  );
}
