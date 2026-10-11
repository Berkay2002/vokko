import { useLayoutEffect, useRef, useState } from "react";
import type { UIEvent } from "react";
import { Accessibility, Bell, Code, Gamepad2, Keyboard, Languages, LogOut, Mic, MessagesSquare, Monitor, Palette, Pencil, Plug, Search, ShieldCheck, User as UserIcon, X } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { request } from "../api/rest";
import { appStore, displayName, useStore } from "../api/store";
import type { User } from "../api/types";
import { isDesktop } from "../desktop";
import { Avatar } from "./Avatar";
import { closeModal, openModal } from "./modalStore";
import { AccessibilityPage } from "./settings/AccessibilityPage";
import { AppearancePage } from "./settings/AppearancePage";
import { Category, Page, RadioGroup, Select, SwitchRow, Unavailable } from "./settings/controls";
import { KeybindsPage } from "./settings/KeybindsPage";
import { NotificationsPage } from "./settings/NotificationsPage";
import { ProfilesPage } from "./settings/ProfilesPage";
import { SettingsBlock, SettingsModal, SettingsNavGroup, SettingsNavItem, SettingsNavSub, SettingsNavSubs, SettingsRow } from "./settings/SettingsModal";
import { settingsSlots } from "./settings/slots";
import { VoiceVideoPage } from "./settings/VoiceVideoPage";
import { WindowsPage } from "./settings/WindowsPage";

type NavIcon = typeof UserIcon;

interface SectionDef {
  id: string;
  label: string;
  icon: NavIcon;
  /** Group heading; "" renders no heading (Discord hides the General title). */
  group: string;
  /** Not listed in the sidebar: reached from the profile header. */
  hidden?: boolean;
  /** Only exists in the desktop (Tauri) shell. */
  desktopOnly?: boolean;
  /** Category headings shown on pages that are not implemented, in Discord's order. */
  outline?: string[];
  /** Extra words the sidebar search matches besides the label and the outline. */
  keywords?: string[];
}

// Order and grouping follow Discord's User Settings sidebar (research/discord-ui-inventory.md S1, settings-modal reference).
// The Billing group (Nitro, Server Boost, Subscriptions, Gift Inventory, Billing) and the desktop-only game pages are left out on purpose.
const ALL_SECTIONS: SectionDef[] = [
  { id: "account", label: "My Account", icon: UserIcon, group: "", outline: ["Account Info", "Password & Security", "Account Status"], keywords: ["username", "display name", "email", "phone", "password", "security", "devices", "disable", "delete"] },
  { id: "privacy", label: "Data & Privacy", icon: ShieldCheck, group: "", outline: ["How Vokko Uses My Data", "Profile Privacy"], keywords: ["data", "personalization", "analytics", "profile"] },
  { id: "content", label: "Content & Social", icon: MessagesSquare, group: "", outline: ["Content Filters", "Spam Filters", "Direct Message (DM) Permissions", "Friend Request Permissions", "Ignore & Block"], keywords: ["messages", "dm", "friends", "block", "filter", "explicit", "spam", "permissions"] },
  { id: "notifications", label: "Notifications", icon: Bell, group: "", keywords: ["sounds", "badges", "email", "desktop", "push", "mentions"] },
  { id: "voice", label: "Voice & Video", icon: Mic, group: "Experience", keywords: ["microphone", "speaker", "camera", "input", "output", "streaming", "audio", "noise"] },
  { id: "appearance", label: "Appearance", icon: Palette, group: "Experience", keywords: ["theme", "dark", "light", "messages", "chat", "zoom", "font", "spellcheck"] },
  { id: "accessibility", label: "Accessibility", icon: Accessibility, group: "Experience", keywords: ["text", "readability", "density", "contrast", "motion", "screen reader", "saturation", "theme"] },
  { id: "keybinds", label: "Keybinds", icon: Keyboard, group: "Experience", keywords: ["shortcuts", "hotkeys", "keyboard", "system"] },
  { id: "language", label: "Language & Time", icon: Languages, group: "Experience", keywords: ["language", "locale", "time format", "12-hour", "24-hour", "clock"] },
  { id: "windows", label: "Windows Settings", icon: Monitor, group: "Experience", desktopOnly: true, keywords: ["startup", "tray", "minimize", "close", "autostart", "login", "open on startup"] },
  { id: "activity", label: "Activity Privacy", icon: Gamepad2, group: "Games & Apps", outline: ["What Activity I Share", "Where I Share Activity"], keywords: ["status", "games", "share", "join"] },
  { id: "connections", label: "Connected Apps", icon: Plug, group: "Games & Apps", outline: ["Connections", "Authorized Apps"], keywords: ["connections", "accounts", "authorized", "integrations"] },
  { id: "developer", label: "Developer", icon: Code, group: "Other", keywords: ["developer mode", "application test mode", "ids", "api"] },
  { id: "profiles", label: "Profiles", icon: UserIcon, group: "", hidden: true },
];

const SECTIONS = ALL_SECTIONS.filter(s => !s.desktopOnly || isDesktop());

/** Build string at the bottom of the sidebar; click copies it. */
const BUILD = `Vokko ${String(import.meta.env.VITE_APP_BUILD ?? import.meta.env.MODE)}`;

/** Headings of a page that become sub-items in the sidebar (blocks and categories; the heading text is the label). */
const HEADINGS = ".sm-block-title, .settings-category-title";

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

type TimeFormat = "auto" | "12" | "24";

function LanguageTime() {
  const [format, setFormat] = useState<TimeFormat>("auto");
  return (
    <Page title="Language & Time">
      <Category title="Select a Language">
        <Select<string> label="Language" value="en" options={[{ value: "en", label: "English" }]} onChange={() => undefined} />
        <p className="settings-todo">More languages are not available yet.</p>
      </Category>
      <Category title="Time format">
        <RadioGroup<TimeFormat>
          name="Time format"
          value={format}
          onChange={setFormat}
          options={[
            { value: "auto", label: "Automatic", note: "Follows your device settings." },
            { value: "12", label: "12-hour" },
            { value: "24", label: "24-hour" },
          ]}
        />
        <Unavailable>The time format is not applied to timestamps yet.</Unavailable>
      </Category>
    </Page>
  );
}

function DeveloperPage() {
  return (
    <Page title="Developer">
      <SwitchRow label="Developer Mode" note="Adds options such as Copy ID to menus." checked={false} disabled onChange={() => undefined} />
      <SwitchRow label="Application Test Mode" note="Enter an application ID to test it." checked={false} disabled onChange={() => undefined} />
      <input className="input" aria-label="Application ID" placeholder="Application ID" disabled />
      <Unavailable>Developer options are not available yet.</Unavailable>
    </Page>
  );
}

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
  const Security = settingsSlots.accountSecurity;
  const Identity = settingsSlots.accountIdentity;
  const SignIn = settingsSlots.signInMethods;
  const unchanged = name.trim() === (me.global_name ?? "");
  const submit = async () => {
    if (await save({ global_name: name.trim() })) setEditing(false);
  };
  return (
    <>
      <SettingsBlock anchor="info" title="Account Info">
        {Identity ? (
          <Identity me={me} />
        ) : (
          <>
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
          </>
        )}
      </SettingsBlock>
      <SettingsBlock anchor="security" title="Password & Security">
        {Security ? (
          <Security />
        ) : (
          <>
            <SettingsRow label="Password" value={<span className="sm-muted">Not available yet</span>}>
              <button type="button" className="sm-btn" disabled title="Not available yet">
                Change
              </button>
            </SettingsRow>
            <SettingsRow label="Logged-in Devices" value={<span className="sm-muted">Not available yet</span>} />
          </>
        )}
      </SettingsBlock>
      {SignIn && (
        <SettingsBlock anchor="signin" title="Sign-in Methods">
          <SignIn />
        </SettingsBlock>
      )}
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

export function UserSettings({ section }: { section?: string }) {
  const me = useStore(s => s.me);
  const [current, setCurrent] = useState(SECTIONS.some(s => s.id === section) ? (section as string) : "account");
  const [subs, setSubs] = useState<string[]>([]);
  const [anchor, setAnchor] = useState(0);
  const [query, setQuery] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  // the sub-items are the headings of the page that is open
  useLayoutEffect(() => {
    const titles = [...(scroller.current?.querySelectorAll<HTMLElement>(HEADINGS) ?? [])].map(el => el.textContent ?? "");
    setSubs(prev => (prev.length === titles.length && prev.every((t, i) => t === titles[i]) ? prev : titles));
  }, [current, me]);

  if (!me) return null;

  const needle = query.trim().toLowerCase();
  const matches = (s: SectionDef) => !needle || [s.label, ...(s.outline ?? []), ...(s.keywords ?? [])].some(t => t.toLowerCase().includes(needle));
  const visible = SECTIONS.filter(s => !s.hidden && matches(s));
  const groups = [...new Set(visible.map(s => s.group))];
  const showLogOut = !needle || "log out".includes(needle);
  const active = SECTIONS.find(s => s.id === current) ?? SECTIONS[0]!;

  const open = (id: string) => {
    setCurrent(id);
    setAnchor(0);
    scroller.current?.scrollTo({ top: 0, behavior: "instant" });
  };

  const scrollToAnchor = (index: number) => {
    const box = scroller.current;
    const title = box?.querySelectorAll<HTMLElement>(HEADINGS)[index];
    if (!box || !title) return;
    setAnchor(index);
    box.scrollTo({ top: Math.max(0, title.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 40) });
  };

  // the sub-item whose heading last passed the top of the page is the current one
  const trackAnchor = (event: UIEvent<HTMLDivElement>) => {
    const box = event.currentTarget;
    const titles = box.querySelectorAll<HTMLElement>(HEADINGS);
    if (titles.length < 2) return;
    const top = box.getBoundingClientRect().top;
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
    let found = 0;
    titles.forEach((title, i) => {
      if (title.getBoundingClientRect().top - top <= 80) found = i;
    });
    if (atEnd && box.scrollTop > 0) found = titles.length - 1;
    setAnchor(found);
  };

  const page = () => {
    switch (current) {
      case "account":
        return <MyAccount me={me} />;
      case "profiles":
        return <ProfilesPage me={me} />;
      case "notifications":
        return <NotificationsPage />;
      case "windows":
        return <WindowsPage />;
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
      case "developer":
        return <DeveloperPage />;
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
        {query && (
          <button type="button" className="sm-search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
            <X size={16} />
          </button>
        )}
      </label>
      <div className="sm-side-list">
        {visible.length === 0 && !showLogOut ? (
          <div className="sm-side-empty">
            <strong>No results found</strong>
            <span>We tried, but got no results.</span>
          </div>
        ) : (
          <>
            {groups.map(group => (
              <SettingsNavGroup key={group || "top"} title={group}>
                {visible
                  .filter(s => s.group === group)
                  .map(s => (
                    <div key={s.id}>
                      <SettingsNavItem icon={s.icon} label={s.label} selected={current === s.id} expanded={current === s.id && subs.length > 1 ? true : undefined} onClick={() => open(s.id)} />
                      {current === s.id && subs.length > 1 && (
                        <SettingsNavSubs>
                          {subs.map((label, i) => (
                            <SettingsNavSub key={`${i}:${label}`} label={label} active={anchor === i} onClick={() => scrollToAnchor(i)} />
                          ))}
                        </SettingsNavSubs>
                      )}
                    </div>
                  ))}
              </SettingsNavGroup>
            ))}
            {showLogOut && (
              <SettingsNavGroup>
                <SettingsNavItem icon={LogOut} label="Log Out" danger onClick={() => openModal({ type: "logout" })} />
              </SettingsNavGroup>
            )}
          </>
        )}
        <div className="sm-side-footer">
          <button type="button" className="sm-build" title="Copy build info" onClick={() => void navigator.clipboard?.writeText(BUILD)}>
            {BUILD}
          </button>
          <div className="sm-side-links">
            <button type="button">Privacy Policy</button>
            <span aria-hidden="true">&bull;</span>
            <button type="button">Terms of Service</button>
            <span aria-hidden="true">&bull;</span>
            <button type="button">More</button>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <SettingsModal label="User Settings" title={active.label} side={side} onClose={closeModal} pageKey={current} scrollRef={scroller} onScroll={trackAnchor}>
      {page()}
    </SettingsModal>
  );
}
