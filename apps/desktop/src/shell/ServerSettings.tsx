import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { Perm } from "../api/permissions";
import { request, uploadAttachment } from "../api/rest";
import { appStore, useStore } from "../api/store";
import { ChannelType, type Channel, type Guild } from "../api/types";
import { OnboardingSettings } from "../community";
import { GuildIcon } from "./Avatar";
import { firstTextChannel } from "./channels";
import { closeModal, openModal } from "./modalStore";
import { Category, Field, Page, Select, Unavailable } from "./settings/controls";
import { FullScreenSettings, useFrameLayout, type SettingsNavGroup } from "./settings/FullScreenSettings";
import { AuditLogPage } from "./settings/AuditLogPage";
import { BansPage } from "./settings/BansPage";
import { AutoModPage, SafetyPage } from "./settings/SafetyPage";
import { SaveBar } from "./settings/SaveBar";
import { RolesPage } from "./settings/RolesPage";
import { TagPage } from "./settings/TagPage";
import { ThemePage } from "./settings/ThemePage";
import { MembersPage } from "./settings/server-people";
import { SoundboardSettingsPage } from "../soundboard";
import { usePermissions } from "./usePermissions";
import { IntegrationsPage } from "../apps/IntegrationsPage";
import { EmojiSettingsPage } from "../emoji/EmojiSettingsPage";
import { InviteList } from "../invites/InviteList";

interface SectionDef {
  id: string;
  label: string;
  /** Sidebar block; headings come from GROUP_TITLES, "" renders without one. */
  group: "top" | "expression" | "people" | "apps" | "moderation" | "bottom";
  /** Category headings shown on pages that are not implemented. */
  outline?: string[];
  /** Any of these permission bits makes the section visible (Q4.6). Empty: MANAGE_GUILD. */
  needs?: bigint[];
}

const MANAGE = [Perm.MANAGE_GUILD];
const EXPRESSIONS = [Perm.MANAGE_GUILD, Perm.MANAGE_GUILD_EXPRESSIONS];

const GROUP_TITLES: Record<SectionDef["group"], string> = {
  top: "",
  expression: "Expression",
  people: "People",
  apps: "Apps",
  moderation: "Moderation",
  bottom: "",
};

const GROUP_ORDER: SectionDef["group"][] = ["top", "expression", "people", "apps", "moderation", "bottom"];

const SECTIONS: SectionDef[] = [
  { id: "profile", label: "Server Profile", group: "top" },
  { id: "tag", label: "Server Tag", group: "top" },
  { id: "theme", label: "Server Theme", group: "top" },
  { id: "engagement", label: "Engagement", group: "top" },
  { id: "emoji", label: "Emoji", group: "expression", needs: EXPRESSIONS },
  { id: "stickers", label: "Stickers", group: "expression", needs: EXPRESSIONS, outline: ["Upload Sticker", "Stickers"] },
  { id: "soundboard", label: "Soundboard", group: "expression", needs: [...EXPRESSIONS, Perm.CREATE_GUILD_EXPRESSIONS] },
  { id: "members", label: "Members", group: "people", needs: [Perm.MANAGE_GUILD, Perm.KICK_MEMBERS, Perm.BAN_MEMBERS, Perm.MODERATE_MEMBERS, Perm.MANAGE_NICKNAMES, Perm.MANAGE_ROLES] },
  { id: "roles", label: "Roles", group: "people", needs: [Perm.MANAGE_ROLES] },
  { id: "invites", label: "Invites", group: "people", needs: [Perm.CREATE_INSTANT_INVITE, Perm.MANAGE_GUILD] },
  { id: "onboarding", label: "Onboarding", group: "people" },
  { id: "access", label: "Access", group: "people", outline: ["Access Options", "Age-Restricted Server", "Server Rules"] },
  { id: "integrations", label: "Integrations", group: "apps", needs: [Perm.MANAGE_GUILD, Perm.MANAGE_WEBHOOKS] },
  { id: "safety", label: "Safety Setup", group: "moderation" },
  { id: "audit", label: "Audit Log", group: "moderation", needs: [Perm.VIEW_AUDIT_LOG] },
  { id: "bans", label: "Bans", group: "moderation", needs: [Perm.BAN_MEMBERS] },
  { id: "automod", label: "AutoMod", group: "moderation" },
  { id: "community", label: "Enable Community", group: "bottom", outline: ["Enable Community"] },
  { id: "template", label: "Server Template", group: "bottom", outline: ["Template Title", "Description"] },
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

/** Asks the frame for the wide content column while the page is mounted. */
function WideLayout() {
  useFrameLayout("wide");
  return null;
}

function Wide({ children }: { children: ReactNode }) {
  useFrameLayout("wide");
  return <>{children}</>;
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
  const dirty = owner && trimmed !== guild.name;

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
      <WideLayout />
      {!owner && <Unavailable>You need the Manage Server permission to change the server profile.</Unavailable>}
      <div className="ss-split">
        <div className="ss-split-main">
      <Field label="Name">
        <div className="account-inline">
          <input className="input" aria-label="Server name" value={name} maxLength={100} readOnly={!owner} disabled={!owner} onChange={e => setName(e.target.value)} />
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
      {error && !dirty && <p className="field-error">{error}</p>}
      {saved && !dirty && <p className="settings-saved">Saved.</p>}
        </div>
        <aside className="ss-preview-card" aria-label="Server profile preview">
          <div className="ss-preview-banner" />
          <div className="ss-preview-icon">
            <GuildIcon guild={guild} size={56} />
          </div>
          <div className="ss-preview-name">{trimmed || guild.name}</div>
        </aside>
      </div>
      <SaveBar
        visible={dirty}
        busy={busy}
        error={trimmed ? error : "Server name is required."}
        onReset={() => setName(guild.name)}
        onSave={() => trimmed && void patch({ name: trimmed })}
      />
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
        {saved && !dirty && <p className="settings-saved">Saved.</p>}
      </Category>
      {ENGAGEMENT_OUTLINE.map(title => (
        <Category key={title} title={title}>
          <p className="settings-todo">Not available yet.</p>
        </Category>
      ))}
      <SaveBar
        visible={owner && dirty}
        busy={busy}
        error={error}
        onReset={() => setValue(guild.system_channel_id ?? "")}
        onSave={() => void patch({ system_channel_id: value === "" ? null : value })}
      />
    </Page>
  );
}

function InvitesPage({ guildId, canCreate, canList, channels }: { guildId: string; canCreate: boolean; canList: boolean; channels: Channel[] }) {
  const target = firstTextChannel(channels) ?? channels[0];
  return (
    <Page title="Invites">
      <p className="settings-todo">Here's a list of all active invite links. You can revoke any one or create one.</p>
      <div className="account-inline">
        <button type="button" className="btn btn-primary" disabled={!target || !canCreate} onClick={() => target && openModal({ type: "invite", channelId: target.id })}>
          Create Invite Link
        </button>
      </div>
      {!canCreate && <p className="settings-todo">You do not have permission to create invite links.</p>}
      <InviteList guildId={guildId} canManage={canList} />
    </Page>
  );
}

/** Sections the viewer may open (rail context menu "Server Settings" submenu). */
export function serverSettingsSections(can: (bit: bigint) => boolean): { id: string; label: string }[] {
  return SECTIONS.filter(s => (s.needs ?? MANAGE).some(bit => can(bit))).map(s => ({ id: s.id, label: s.label }));
}

export function ServerSettings({ guildId, section }: { guildId: string; section?: string }) {
  const guild = useStore(s => s.guilds[guildId]);
  const allChannels = useStore(s => s.channels);
  const members = useStore(s => s.members[guildId]);
  const meId = useStore(s => s.me?.id);
  const perms = usePermissions(guildId);
  const [current, setCurrent] = useState(section ?? "profile");
  const channels = useMemo(() => Object.values(allChannels).filter(c => c.guild_id === guildId), [allChannels, guildId]);
  if (!guild) return null;

  const owner = guild.owner_id === meId;
  const canManage = owner || perms.can(Perm.MANAGE_GUILD);
  const visibleSections = SECTIONS.filter(s => (s.needs ?? MANAGE).some(bit => perms.can(bit)));
  const active = visibleSections.find(s => s.id === current) ?? visibleSections[0];
  if (!active) return null;
  const canInvite = perms.can(Perm.CREATE_INSTANT_INVITE) || perms.can(Perm.MANAGE_GUILD);

  const page = () => {
    switch (active.id) {
      case "profile":
        return <ProfilePage guild={guild} owner={canManage} channels={channels} />;
      case "engagement":
        return <EngagementPage guild={guild} owner={canManage} channels={channels} />;
      case "tag":
        return <TagPage guildId={guildId} canEdit={canManage} />;
      case "theme":
        return <ThemePage guildId={guildId} canEdit={canManage} />;
      case "members":
        return (
          <Wide>
            <MembersPage guild={guild} members={members} />
          </Wide>
        );
      case "roles":
        return <RolesPage guild={guild} members={members} />;
      case "invites":
        return <InvitesPage guildId={guildId} canCreate={canInvite} canList={canManage} channels={channels} />;
      case "bans":
        return <BansPage guild={guild} />;
      case "integrations":
        return <IntegrationsPage guild={guild} canManageGuild={canManage} canManageWebhooks={owner || perms.can(Perm.MANAGE_WEBHOOKS)} />;
      case "emoji":
        return <EmojiSettingsPage guildId={guildId} canEdit={owner || perms.can(Perm.MANAGE_GUILD_EXPRESSIONS)} channels={channels} />;
      case "audit":
        return (
          <Wide>
            <AuditLogPage guild={guild} />
          </Wide>
        );
      case "safety":
        return <SafetyPage guild={guild} canEdit={canManage} />;
      case "automod":
        return <AutoModPage guild={guild} canEdit={canManage} />;
      case "onboarding":
        return <OnboardingSettings guildId={guildId} />;
      case "soundboard":
        return <SoundboardSettingsPage guildId={guildId} />;
      default:
        return <NotYet section={active} />;
    }
  };

  const groups: SettingsNavGroup[] = GROUP_ORDER.map(group => ({
    id: group,
    title: GROUP_TITLES[group],
    items: [
      ...visibleSections.filter(s => s.group === group).map(s => ({ id: s.id, label: s.label })),
      ...(group === "bottom" && owner
        ? [{ id: "delete", label: "Delete Server", danger: true, icon: <Trash2 size={16} aria-hidden="true" />, onSelect: () => openModal({ type: "deleteServer", guildId }) }]
        : []),
    ],
  })).filter(g => g.items.length > 0);

  return (
    <FullScreenSettings
      label="Server Settings"
      navLabel="Server settings sections"
      eyebrow={guild.name}
      eyebrowTitle={guild.name}
      groups={groups}
      current={active.id}
      onSelect={setCurrent}
      onClose={closeModal}
    >
      {page()}
    </FullScreenSettings>
  );
}
