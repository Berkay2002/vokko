import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { request, uploadAttachment } from "../api/rest";
import { appStore, avatarUrl, displayName, useStore } from "../api/store";
import type { User } from "../api/types";
import { useFocusTrap, useLayer } from "../ui";
import { Avatar } from "./Avatar";
import { closeModal, openModal } from "./modalStore";
import { AccessibilityPage } from "./settings/AccessibilityPage";
import { AppearancePage } from "./settings/AppearancePage";
import { Category, Page, Select, Unavailable } from "./settings/controls";
import { KeybindsPage } from "./settings/KeybindsPage";
import { NotificationsPage } from "./settings/NotificationsPage";
import { VoiceVideoPage } from "./settings/VoiceVideoPage";

interface SectionDef {
  id: string;
  label: string;
  /** Group heading; "" renders no heading (Discord hides the General and Other titles). */
  group: string;
  /** Category headings shown on pages that are not implemented, in Discord's order. */
  outline?: string[];
}

// Order and grouping follow Discord's User Settings sidebar (research/discord-ui-inventory.md S1). The Billing group
// (Nitro, Server Boost, Subscriptions, Gift Inventory, Billing) and the desktop-only game pages are left out on purpose.
const SECTIONS: SectionDef[] = [
  { id: "profiles", label: "Profiles", group: "" },
  { id: "account", label: "My Account", group: "General" },
  { id: "privacy", label: "Data & Privacy", group: "General", outline: ["How Vokko Uses My Data", "Profile Privacy"] },
  { id: "content", label: "Content & Social", group: "General", outline: ["Content Filters", "Spam Filters", "Direct Message (DM) Permissions", "Friend Request Permissions", "Ignore & Block"] },
  { id: "notifications", label: "Notifications", group: "General" },
  { id: "voice", label: "Voice & Video", group: "Experience" },
  { id: "appearance", label: "Appearance", group: "Experience" },
  { id: "accessibility", label: "Accessibility", group: "Experience" },
  { id: "keybinds", label: "Keybinds", group: "Experience" },
  { id: "language", label: "Language & Time", group: "Experience" },
  { id: "activity", label: "Activity Privacy", group: "Games & Apps", outline: ["What Activity I Share", "Where I Share Activity"] },
  { id: "connections", label: "Connected Apps", group: "Games & Apps", outline: ["Connections", "Authorized Apps"] },
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
  const [name, setName] = useState(me.global_name ?? "");
  const { busy, error, saved, save } = useSave();
  return (
    <div className="settings-page">
      <h1>My Account</h1>
      <div className="account-card">
        <div className="account-banner" style={{ background: me.banner_color ?? "var(--brand-500)" }} />
        <div className="account-head">
          <Avatar user={me} size={80} status />
          <div className="account-names">
            <div className="account-display">{displayName(me)}</div>
            <div className="account-username">{me.username}</div>
          </div>
        </div>
        <div className="account-fields">
          <div className="account-field">
            <div className="field-label">Display Name</div>
            <div className="account-inline">
              <input className="input" value={name} maxLength={32} placeholder={me.username} onChange={e => setName(e.target.value)} />
              <button type="button" className="btn btn-primary btn-sm" disabled={busy || name.trim() === (me.global_name ?? "")} onClick={() => void save({ global_name: name.trim() })}>
                Save
              </button>
            </div>
          </div>
          <div className="account-field">
            <div className="field-label">Username</div>
            <div className="account-value">{me.username}</div>
          </div>
        </div>
      </div>
      {error && <p className="field-error">{error}</p>}
      {saved && <p className="settings-saved">Saved.</p>}
    </div>
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
      <h1>Profiles</h1>
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
              <img className="avatar-img" src={avatarUrl(me)} alt="" width={80} height={80} />
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
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useLayer(true, closeModal);
  useFocusTrap(true, () => root.current);
  if (!me) return null;

  const needle = query.trim().toLowerCase();
  const visible = SECTIONS.filter(s => !needle || s.label.toLowerCase().includes(needle) || (s.outline ?? []).some(o => o.toLowerCase().includes(needle)));
  const groups = [...new Set(visible.map(s => s.group))];
  const active = SECTIONS.find(s => s.id === current) ?? SECTIONS[0];

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
        return active ? <NotYet section={active} /> : null;
    }
  };

  return createPortal(
    <div ref={root} className="settings-overlay" role="dialog" aria-modal="true" aria-label="User Settings" tabIndex={-1}>
      <nav className="settings-sidebar" aria-label="Settings sections">
        <div className="settings-sidebar-inner">
          <input className="settings-search" type="search" placeholder="Search" aria-label="Search settings" value={query} onChange={e => setQuery(e.target.value)} />
          {groups.map(group => (
            <div key={group || "top"} className="settings-group">
              {group && <div className="settings-group-title">{group}</div>}
              {visible
                .filter(s => s.group === group)
                .map(s => (
                  <button key={s.id} type="button" className={`settings-item${current === s.id ? " selected" : ""}`} onClick={() => setCurrent(s.id)}>
                    {s.label}
                  </button>
                ))}
            </div>
          ))}
          <div className="settings-group">
            <div className="settings-separator" />
            <button type="button" className="settings-item danger" onClick={() => openModal({ type: "logout" })}>
              Log Out
            </button>
          </div>
        </div>
      </nav>
      <main className="settings-content">
        <div className="settings-content-inner">{page()}</div>
        <button type="button" className="settings-close" aria-label="Close" onClick={closeModal}>
          <span className="settings-close-icon">
            <X size={18} />
          </span>
          <span className="settings-close-label">ESC</span>
        </button>
      </main>
    </div>,
    document.body,
  );
}
