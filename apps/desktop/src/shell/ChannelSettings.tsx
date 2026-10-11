// Full-screen channel settings: Overview + Permissions (Invites and Integrations are placeholders).
import { useMemo, useState } from "react";
import { Eye, Hash, Lock, Smile, Trash2, Volume2 } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { Perm } from "../api/permissions";
import { request } from "../api/rest";
import { appStore, useStore } from "../api/store";
import { ChannelType, type Channel, type Snowflake } from "../api/types";
import { ForumSettingsPage } from "../forum/ForumSettings";
import { isPrivateChannel } from "./channelPrivacy";
import { closeModal, openModal } from "./modalStore";
import { ChannelPermissionsPage } from "./settings/ChannelPermissions";
import { Category, Field, Page, RadioGroup, Select, Unavailable } from "./settings/controls";
import { FullScreenSettings, type SettingsNavGroup } from "./settings/FullScreenSettings";
import { SaveBar } from "./settings/SaveBar";
import { usePermissions } from "./usePermissions";

type SectionId = "overview" | "forum" | "permissions" | "invites" | "integrations";

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "forum", label: "Forum" },
  { id: "permissions", label: "Permissions" },
  { id: "invites", label: "Invites" },
  { id: "integrations", label: "Integrations" },
];

function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "Something went wrong. Try again.";
}

const TOPIC_MAX = 1024;

/** Disabled select used for settings that have no backend yet. */
function LockedSelect({ label, value }: { label: string; value: string }) {
  return <Select<string> label={label} value="current" options={[{ value: "current", label: value }]} disabled onChange={() => undefined} />;
}

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
          <div className="cs-rich">
            <div className="cs-rich-toolbar" aria-hidden="true">
              <span className="cs-rich-btn cs-rich-bold">B</span>
              <span className="cs-rich-btn cs-rich-italic">I</span>
              <span className="cs-rich-btn cs-rich-underline">U</span>
              <span className="cs-rich-btn cs-rich-strike">S</span>
              <span className="cs-rich-btn">
                <Eye size={16} />
              </span>
              <span className="cs-rich-spacer" />
              <span className="cs-rich-btn">
                <Smile size={16} />
              </span>
            </div>
            <textarea
              className="cs-rich-input"
              aria-label="Channel topic"
              rows={4}
              maxLength={TOPIC_MAX}
              value={topic}
              disabled={!editable}
              placeholder="Let everyone know how to use this channel!"
              onChange={e => {
                setSaved(false);
                setTopic(e.target.value);
              }}
            />
            <div className="cs-rich-count" aria-label="Characters remaining">
              {TOPIC_MAX - topic.length}
            </div>
          </div>
        </Field>
      )}
      {!category && !voice && (
        <>
          <Field label="Slowmode" note="Not available yet.">
            <LockedSelect label="Slowmode" value="Off" />
          </Field>
          <Field label="Content Visibility" note="Not available yet.">
            <RadioGroup<string>
              name="Content visibility"
              value="default"
              disabled
              options={[
                { value: "default", label: "Default" },
                { value: "spoiler", label: "Spoiler Channel", note: "Media posted in this channel is hidden until revealed." },
                { value: "age", label: "Age-Restricted Channel", note: "Members must confirm they are an adult to view this channel." },
              ]}
              onChange={() => undefined}
            />
          </Field>
          <Field label="Hide After Inactivity" note="Not available yet.">
            <LockedSelect label="Hide after inactivity" value="3 Days" />
          </Field>
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
  const isCategory = channel?.type === ChannelType.GuildCategory;
  const isForum = channel?.type === ChannelType.GuildForum;
  const sections = isCategory ? SECTIONS.filter(s => s.id === "overview" || s.id === "permissions") : SECTIONS.filter(s => s.id !== "forum" || isForum);
  const initial = sections.some(s => s.id === section) ? (section as SectionId) : "overview";
  const [current, setCurrent] = useState<SectionId>(initial);
  const privateChannel = useMemo(() => isPrivateChannel(channel, channel?.guild_id), [channel]);
  if (!channel || !guild) return null;

  const canManage = can(Perm.MANAGE_CHANNELS);
  const category = channel.type === ChannelType.GuildCategory;

  const page = () => {
    switch (current) {
      case "overview":
        return <OverviewPage key={channel.id} channel={channel} editable={canManage} />;
      case "forum":
        return <ForumSettingsPage key={channel.id} channel={channel} editable={canManage} />;
      case "permissions":
        return <ChannelPermissionsPage key={channel.id} channel={channel} guild={guild} members={members} />;
      case "invites":
        return (
          <Page title="Invites">
            <p className="settings-todo">Invite links for this channel let people join your server straight into it.</p>
            <Unavailable>Not available yet.</Unavailable>
          </Page>
        );
      case "integrations":
        return (
          <Page title="Integrations">
            <Category title="Webhooks">
              <p className="settings-todo">Not available yet.</p>
            </Category>
            <Category title="Followed Channels">
              <p className="settings-todo">Not available yet.</p>
            </Category>
          </Page>
        );
    }
  };

  const eyebrow = category ? (
    channel.name
  ) : (
    <span className="cs-header-name">
      {privateChannel ? <Lock size={12} aria-hidden="true" /> : channel.type === ChannelType.GuildVoice ? <Volume2 size={12} aria-hidden="true" /> : <Hash size={12} aria-hidden="true" />}
      <span>{channel.name}</span>
    </span>
  );
  const groups: SettingsNavGroup[] = [
    { id: "main", items: sections.map(s => ({ id: s.id, label: s.label })) },
    ...(canManage
      ? [
          {
            id: "danger",
            items: [{ id: "delete", label: `Delete ${category ? "Category" : "Channel"}`, danger: true, icon: <Trash2 size={16} aria-hidden="true" />, onSelect: () => openModal({ type: "deleteChannel", channelId }) }],
          },
        ]
      : []),
  ];

  return (
    <FullScreenSettings
      label="Channel Settings"
      navLabel="Channel settings sections"
      eyebrow={eyebrow}
      eyebrowTitle={channel.name ?? undefined}
      groups={groups}
      current={current}
      onSelect={id => setCurrent(id as SectionId)}
      onClose={closeModal}
    >
      {page()}
    </FullScreenSettings>
  );
}
