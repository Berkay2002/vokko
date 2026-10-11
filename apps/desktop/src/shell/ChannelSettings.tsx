// Full-screen channel settings: Overview + Permissions (Invites and Integrations are placeholders).
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Hash, Lock, Volume2, X } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { Perm } from "../api/permissions";
import { request } from "../api/rest";
import { appStore, useStore } from "../api/store";
import { ChannelType, type Channel, type Snowflake } from "../api/types";
import { useFocusTrap, useLayer } from "../ui";
import { isPrivateChannel } from "./channelPrivacy";
import { closeModal, openModal } from "./modalStore";
import { ChannelPermissionsPage } from "./settings/ChannelPermissions";
import { Category, Field, Page, Unavailable } from "./settings/controls";
import { SaveBar } from "./settings/SaveBar";
import { usePermissions } from "./usePermissions";

type SectionId = "overview" | "permissions" | "invites" | "integrations";

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "permissions", label: "Permissions" },
  { id: "invites", label: "Invites" },
  { id: "integrations", label: "Integrations" },
];

function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "Something went wrong. Try again.";
}

const kindTitle = (type: ChannelType): string => (type === ChannelType.GuildVoice ? "Voice Channels" : type === ChannelType.GuildCategory ? "Category" : "Text Channels");

function NotAvailable({ label, note }: { label: string; note?: string }) {
  return (
    <Field label={label} note={note}>
      <input className="input" disabled aria-label={label} placeholder="Not available yet" />
    </Field>
  );
}

function OverviewPage({ channel, editable }: { channel: Channel; editable: boolean }) {
  const category = channel.type === ChannelType.GuildCategory;
  const voice = channel.type === ChannelType.GuildVoice;
  const [name, setName] = useState(channel.name ?? "");
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const slug = category ? name.trim() : name.trim().toLowerCase().replace(/\s+/g, "-");
  const nextTopic = topic.trim() || null;
  const dirty = slug !== (channel.name ?? "") || (!category && nextTopic !== (channel.topic ?? null));

  const reset = () => {
    setName(channel.name ?? "");
    setTopic(channel.topic ?? "");
    setError(null);
  };
  const save = () => {
    if (!slug) return;
    setBusy(true);
    setError(null);
    request<Channel>("PATCH", `/channels/${channel.id}`, { name: slug, ...(category ? {} : { topic: nextTopic }) })
      .then(updated => {
        appStore.getState().upsertChannel(updated);
        setName(updated.name ?? slug);
        setTopic(updated.topic ?? "");
        setSaved(true);
      })
      .catch(e => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Page title="Overview">
      {!editable && <Unavailable>You need the Manage Channel permission to edit this {category ? "category" : "channel"}.</Unavailable>}
      <Field label={category ? "Category Name" : "Channel Name"}>
        <div className="input-prefixed">
          {!category && (voice ? <Volume2 size={16} /> : <Hash size={16} />)}
          <input
            className="input"
            aria-label={category ? "Category name" : "Channel name"}
            value={name}
            maxLength={100}
            disabled={!editable}
            onChange={e => {
              setSaved(false);
              setName(e.target.value);
            }}
          />
        </div>
      </Field>
      {!category && (
        <Field label="Channel Topic">
          <textarea
            className="input textarea"
            aria-label="Channel topic"
            rows={4}
            maxLength={1024}
            value={topic}
            disabled={!editable}
            placeholder="Let everyone know how to use this channel!"
            onChange={e => {
              setSaved(false);
              setTopic(e.target.value);
            }}
          />
        </Field>
      )}
      {!category && !voice && (
        <>
          <NotAvailable label="Slowmode" note="Not available yet." />
          <NotAvailable label="Age-Restricted Channel" note="Not available yet." />
          <NotAvailable label="Hide After Inactivity" note="Not available yet." />
        </>
      )}
      {voice && (
        <>
          <NotAvailable label="Bitrate" note="Not available yet." />
          <NotAvailable label="User Limit" note="Not available yet." />
        </>
      )}
      {saved && !dirty && <p className="settings-saved">Saved.</p>}
      <SaveBar visible={editable && (dirty || !!error)} busy={busy} error={error} onReset={reset} onSave={save} />
    </Page>
  );
}

export function ChannelSettings({ channelId, section }: { channelId: Snowflake; section?: string }) {
  const channel = useStore(s => s.channels[channelId]);
  const guild = useStore(s => (channel?.guild_id ? s.guilds[channel.guild_id] : undefined));
  const members = useStore(s => (channel?.guild_id ? s.members[channel.guild_id] : undefined));
  const { can } = usePermissions(channel?.guild_id, channelId);
  const initial = SECTIONS.some(s => s.id === section) ? (section as SectionId) : "overview";
  const [current, setCurrent] = useState<SectionId>(initial);
  const root = useRef<HTMLDivElement>(null);
  useLayer(true, closeModal);
  useFocusTrap(true, () => root.current);
  const privateChannel = useMemo(() => isPrivateChannel(channel, channel?.guild_id), [channel]);
  if (!channel || !guild) return null;

  const canManage = can(Perm.MANAGE_CHANNELS);
  const category = channel.type === ChannelType.GuildCategory;

  const page = () => {
    switch (current) {
      case "overview":
        return <OverviewPage key={channel.id} channel={channel} editable={canManage} />;
      case "permissions":
        return <ChannelPermissionsPage key={channel.id} channel={channel} guild={guild} members={members} />;
      case "invites":
        return (
          <Page title="Invites">
            <Unavailable>Not available yet.</Unavailable>
          </Page>
        );
      case "integrations":
        return (
          <Page title="Integrations">
            <Category title="Webhooks">
              <p className="settings-todo">Not available yet.</p>
            </Category>
          </Page>
        );
    }
  };

  return createPortal(
    <div ref={root} className="settings-overlay" role="dialog" aria-modal="true" aria-label="Channel Settings" tabIndex={-1}>
      <nav className="settings-sidebar" aria-label="Channel settings sections">
        <div className="settings-sidebar-inner">
          <div className="settings-group">
            <div className="settings-group-title cs-header" title={channel.name ?? undefined}>
              <span className="cs-header-name">
                {category ? null : privateChannel ? <Lock size={12} /> : channel.type === ChannelType.GuildVoice ? <Volume2 size={12} /> : <Hash size={12} />}
                <span>{channel.name}</span>
              </span>
              <span className="cs-header-kind">{kindTitle(channel.type)}</span>
            </div>
            {SECTIONS.map(s => (
              <button key={s.id} type="button" className={`settings-item${current === s.id ? " selected" : ""}`} aria-current={current === s.id ? "page" : undefined} onClick={() => setCurrent(s.id)}>
                {s.label}
              </button>
            ))}
            {canManage && (
              <>
                <div className="settings-separator" />
                <button type="button" className="settings-item danger" onClick={() => openModal({ type: "deleteChannel", channelId })}>
                  Delete {category ? "Category" : "Channel"}
                </button>
              </>
            )}
          </div>
        </div>
      </nav>
      <main className="settings-content">
        <div className="settings-content-inner cs-content">{page()}</div>
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
