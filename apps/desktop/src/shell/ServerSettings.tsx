import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { request, uploadAttachment } from "../api/rest";
import { appStore, useStore } from "../api/store";
import { ChannelType, type Channel, type Guild } from "../api/types";
import { useFocusTrap, useLayer } from "../ui";
import { GuildIcon } from "./Avatar";
import { firstTextChannel } from "./channels";
import { closeModal, openModal } from "./modalStore";
import { Category, Field, Page, Select, Unavailable } from "./settings/controls";
import { MembersPage, RolesPage } from "./settings/server-people";

interface SectionDef {
  id: string;
  label: string;
  /** Sidebar block; headings come from GROUP_TITLES, "" or "top"/"misc" render without one. */
  group: "top" | "expression" | "people" | "apps" | "moderation" | "misc" | "bottom";
  /** Category headings shown on pages that are not implemented. */
  outline?: string[];
}

const GROUP_TITLES: Record<SectionDef["group"], string> = {
  top: "",
  expression: "Expression",
  people: "People",
  apps: "Apps",
  moderation: "Moderation",
  misc: "",
  bottom: "",
};

const GROUP_ORDER: SectionDef["group"][] = ["top", "expression", "people", "apps", "moderation", "misc", "bottom"];

const SECTIONS: SectionDef[] = [
  { id: "profile", label: "Server Profile", group: "top" },
  { id: "tag", label: "Server Tag", group: "top" },
  { id: "theme", label: "Server Theme", group: "top" },
  { id: "engagement", label: "Engagement", group: "top" },
  { id: "perks", label: "Boost Perks", group: "top" },
  { id: "emoji", label: "Emoji", group: "expression" },
  { id: "stickers", label: "Stickers", group: "expression" },
  { id: "soundboard", label: "Soundboard", group: "expression" },
  { id: "official", label: "Official Messages", group: "expression" },
  { id: "members", label: "Members", group: "people" },
  { id: "roles", label: "Roles", group: "people" },
  { id: "invites", label: "Invites", group: "people" },
  { id: "access", label: "Access", group: "people" },
  { id: "integrations", label: "Integrations", group: "apps" },
  { id: "directory", label: "App Directory", group: "apps" },
  { id: "safety", label: "Safety Setup", group: "moderation" },
  { id: "audit", label: "Audit Log", group: "moderation" },
  { id: "bans", label: "Bans", group: "moderation" },
  { id: "automod", label: "AutoMod", group: "moderation" },
  { id: "community", label: "Community", group: "misc" },
  { id: "onboarding", label: "Onboarding", group: "misc" },
  { id: "insights", label: "Server Insights", group: "misc" },
  { id: "welcome", label: "Welcome Screen", group: "misc" },
  { id: "webpage", label: "Server Web Page", group: "misc" },
  { id: "template", label: "Server Template", group: "bottom" },
];

const ENGAGEMENT_OUTLINE = ["Channel Summaries", "Activity Feed Settings", "Default Notification Settings", "Inactive", "Server Widget"];

function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "Something went wrong. Try again.";
}

function mergeGuild(guild: Guild): void {
  const state = appStore.getState();
  appStore.setState({ guilds: { ...state.guilds, [guild.id]: { ...state.guilds[guild.id], ...guild } } });
}

function NotYet({ section }: { section: SectionDef }) {
  return (
    <Page title={section.label}>
      <Unavailable>Not available yet.</Unavailable>
      {section.outline?.map(title => (
        <Category key={title} title={title}>
          <p className="settings-todo">Not available yet.</p>
        </Category>
      ))}
    </Page>
  );
}

function useGuildPatch(guildId: string) {
  const [state, setState] = useState<{ busy: boolean; error: string | null; saved: boolean }>({ busy: false, error: null, saved: false });
  const patch = async (body: Record<string, unknown>): Promise<boolean> => {
    setState({ busy: true, error: null, saved: false });
    try {
      const guild = await request<Guild>("PATCH", `/guilds/${guildId}`, body);
      mergeGuild(guild);
      setState({ busy: false, error: null, saved: true });
      return true;
    } catch (error) {
      setState({ busy: false, error: errorText(error), saved: false });
      return false;
    }
  };
  return { ...state, patch };
}

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = (text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };
  return [copied, copy];
}

function ProfilePage({ guild, owner, channels }: { guild: Guild; owner: boolean; channels: Channel[] }) {
  const [name, setName] = useState(guild.name);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [copied, copy] = useCopy();
  const file = useRef<HTMLInputElement>(null);
  const { busy, error, saved, patch } = useGuildPatch(guild.id);
  const uploadChannel = firstTextChannel(channels)?.id ?? channels[0]?.id;
  const trimmed = name.trim();

  const pick = async (selected: File | undefined) => {
    if (!selected || !uploadChannel) return;
    setUploading(true);
    setUploadError(null);
    try {
      const attachment = await uploadAttachment(uploadChannel, selected);
      await patch({ icon_attachment_id: attachment.id });
    } catch (e) {
      setUploadError(errorText(e));
    } finally {
      setUploading(false);
      if (file.current) file.current.value = "";
    }
  };

  return (
    <Page title="Server Profile">
      {!owner && <Unavailable>Only the server owner can change the server profile.</Unavailable>}
      <Field label="Name">
        <div className="account-inline">
          <input className="input" aria-label="Server name" value={name} maxLength={100} readOnly={!owner} disabled={!owner} onChange={e => setName(e.target.value)} />
          {owner && (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || trimmed.length === 0 || trimmed === guild.name} onClick={() => void patch({ name: trimmed })}>
              Save
            </button>
          )}
        </div>
      </Field>
      <Field label="Icon" note="We recommend an image of at least 512x512 for the server.">
        <div className="ss-icon-row">
          <GuildIcon guild={guild} size={80} />
          {owner && (
            <div className="account-inline">
              <button type="button" className="btn btn-primary btn-sm" disabled={uploading || !uploadChannel} onClick={() => file.current?.click()}>
                {uploading ? "Uploading…" : "Upload Image"}
              </button>
              <button type="button" className="btn btn-link btn-sm" disabled={busy || !guild.icon} onClick={() => void patch({ icon_attachment_id: null })}>
                Remove Icon
              </button>
              <input ref={file} type="file" accept="image/*" hidden aria-label="Server icon file" onChange={e => void pick(e.target.files?.[0])} />
            </div>
          )}
        </div>
      </Field>
      <Field label="Server ID">
        <div className="account-inline">
          <code className="ss-id">{guild.id}</code>
          <button type="button" className="btn btn-link btn-sm" onClick={() => copy(guild.id)}>
            {copied ? "Copied" : "Copy ID"}
          </button>
        </div>
      </Field>
      {uploadError && <p className="field-error">{uploadError}</p>}
      {error && <p className="field-error">{error}</p>}
      {saved && <p className="settings-saved">Saved.</p>}
    </Page>
  );
}

function EngagementPage({ guild, owner, channels }: { guild: Guild; owner: boolean; channels: Channel[] }) {
  const textChannels = useMemo(() => channels.filter(c => c.type === ChannelType.GuildText).sort((a, b) => a.position - b.position), [channels]);
  const [value, setValue] = useState(guild.system_channel_id ?? "");
  const { busy, error, saved, patch } = useGuildPatch(guild.id);
  const options = [{ value: "", label: "No System Channel" }, ...textChannels.map(c => ({ value: c.id, label: `#${c.name ?? c.id}` }))];
  const dirty = value !== (guild.system_channel_id ?? "");

  return (
    <Page title="Engagement">
      <Category title="System Messages Channel">
        <Select<string> label="System Messages Channel" value={value} options={options} disabled={!owner || busy} onChange={setValue} />
        {owner && (
          <div className="account-inline ss-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !dirty} onClick={() => void patch({ system_channel_id: value === "" ? null : value })}>
              Save
            </button>
            {saved && <span className="settings-saved">Saved.</span>}
          </div>
        )}
        {error && <p className="field-error">{error}</p>}
      </Category>
      {ENGAGEMENT_OUTLINE.map(title => (
        <Category key={title} title={title}>
          <p className="settings-todo">Not available yet.</p>
        </Category>
      ))}
    </Page>
  );
}

function InvitesPage({ owner, channels }: { owner: boolean; channels: Channel[] }) {
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, copy] = useCopy();
  const target = firstTextChannel(channels) ?? channels[0];

  const create = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const invite = await request<{ code: string; expires_at: string | null }>("POST", `/channels/${target.id}/invites`, { max_age: 86_400 });
      setCode(invite.code);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const link = code ? `vokko.gg/${code}` : "";

  return (
    <Page title="Invites">
      <p className="settings-todo">Invite links let people join your server.</p>
      <div className="account-inline">
        <button type="button" className="btn btn-primary" disabled={busy || !target || !owner} onClick={() => void create()}>
          Create Invite Link
        </button>
      </div>
      {!owner && <p className="settings-todo">Only the server owner can create invite links here.</p>}
      {error && <p className="field-error">{error}</p>}
      {code && (
        <div className="ss-invite" role="status">
          <code className="ss-id">{link}</code>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => copy(link)}>
            {copied ? "Copied" : "Copy"}
          </button>
          <span className="ss-invite-note">expires in 24 hours</span>
        </div>
      )}
      <table className="ss-table">
        <thead>
          <tr>
            <th scope="col">Inviter</th>
            <th scope="col">Invite Code</th>
            <th scope="col">Uses</th>
            <th scope="col">Expires</th>
          </tr>
        </thead>
      </table>
      <p className="settings-todo">No active invite links. Listing existing invites is not available yet.</p>
    </Page>
  );
}

export function ServerSettings({ guildId, section }: { guildId: string; section?: string }) {
  const guild = useStore(s => s.guilds[guildId]);
  const allChannels = useStore(s => s.channels);
  const members = useStore(s => s.members[guildId]);
  const meId = useStore(s => s.me?.id);
  const [current, setCurrent] = useState(section ?? "profile");
  const root = useRef<HTMLDivElement>(null);
  useLayer(true, closeModal);
  useFocusTrap(true, () => root.current);
  const channels = useMemo(() => Object.values(allChannels).filter(c => c.guild_id === guildId), [allChannels, guildId]);
  if (!guild) return null;

  const owner = guild.owner_id === meId;
  const active = SECTIONS.find(s => s.id === current) ?? SECTIONS[0];

  const page = () => {
    switch (current) {
      case "profile":
        return <ProfilePage guild={guild} owner={owner} channels={channels} />;
      case "engagement":
        return <EngagementPage guild={guild} owner={owner} channels={channels} />;
      case "members":
        return <MembersPage guild={guild} members={members} />;
      case "roles":
        return <RolesPage guild={guild} members={members} />;
      case "invites":
        return <InvitesPage owner={owner} channels={channels} />;
      default:
        return active ? <NotYet section={active} /> : null;
    }
  };

  return createPortal(
    <div ref={root} className="settings-overlay" role="dialog" aria-modal="true" aria-label="Server Settings" tabIndex={-1}>
      <nav className="settings-sidebar" aria-label="Server settings sections">
        <div className="settings-sidebar-inner">
          <div className="ss-guild-name" title={guild.name}>
            {guild.name}
          </div>
          {GROUP_ORDER.map(group => {
            const items = SECTIONS.filter(s => s.group === group);
            if (items.length === 0) return null;
            const title = GROUP_TITLES[group];
            return (
              <div key={group} className="settings-group">
                {title && <div className="settings-group-title">{title}</div>}
                {items.map(s => (
                  <button key={s.id} type="button" className={`settings-item${current === s.id ? " selected" : ""}`} aria-current={current === s.id ? "page" : undefined} onClick={() => setCurrent(s.id)}>
                    {s.label}
                  </button>
                ))}
                {group === "bottom" && owner && (
                  <button type="button" className="settings-item danger" onClick={() => openModal({ type: "deleteServer", guildId })}>
                    Delete Server
                  </button>
                )}
              </div>
            );
          })}
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
