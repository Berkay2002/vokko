// Full-screen channel settings: Overview + Permissions + Invites (channel invite list) + Integrations (webhooks, src/apps).
import { useMemo, useRef, useState } from "react";
import { Eye, Hash, Lock, Radio, Trash2, Volume2 } from "lucide-react";
import { toggleWrap } from "../chat/composer/edit";
import { ApiRequestError } from "../api/errors";
import { Perm } from "../api/permissions";
import { request } from "../api/rest";
import { appStore, useStore } from "../api/store";
import { ChannelType, STAGE_TOPIC_MAX_CHARS, type Channel, type Snowflake } from "../api/types";
import { ForumSettingsPage } from "../forum/ForumSettings";
import { isPrivateChannel } from "./channelPrivacy";
import { closeModal, openModal } from "./modalStore";
import { ChannelPermissionsPage } from "./settings/ChannelPermissions";
import { Category, Divider, Field, Page, RadioGroup, Select, Slider, Unavailable } from "./settings/controls";
import { useVoice, useVoiceUi } from "../voice";
import { editStageTopic, isStageModeratorBits } from "../voice/moderation";
import { FullScreenSettings, type SettingsNavGroup } from "./settings/FullScreenSettings";
import { SaveBar } from "./settings/SaveBar";
import { blockedByUnsaved } from "./settings/unsaved";
import { usePermissions } from "./usePermissions";
import { ChannelIntegrations } from "../apps/IntegrationsPage";
import { InviteList } from "../invites/InviteList";
import { SLOWMODE_CHOICES, slowmodeLabel } from "../chat/slowmode";

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
const TOPIC_FORMATS: { label: string; marker: string; className: string; text?: string }[] = [
  { label: "Bold", marker: "**", className: "cs-rich-bold", text: "B" },
  { label: "Italic", marker: "*", className: "cs-rich-italic", text: "I" },
  { label: "Underline", marker: "__", className: "cs-rich-underline", text: "U" },
  { label: "Strikethrough", marker: "~~", className: "cs-rich-strike", text: "S" },
  { label: "Spoiler", marker: "||", className: "" },
];

/** Disabled select used for settings that have no backend yet. */
function LockedSelect({ label, value }: { label: string; value: string }) {
  return <Select<string> label={label} value="current" options={[{ value: "current", label: value }]} disabled onChange={() => undefined} />;
}

function OverviewPage({ channel, editable }: { channel: Channel; editable: boolean }) {
  const category = channel.type === ChannelType.GuildCategory;
  const voice = channel.type === ChannelType.GuildVoice;
  const stage = channel.type === ChannelType.GuildStage;
  const [name, setName] = useState(channel.name ?? "");
  const [topic, setTopic] = useState(channel.topic ?? "");
  const topicRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Text channel names are slugs; voice, stage and category names keep their case and spaces.
  const slug = category || voice || stage ? name.trim() : name.trim().toLowerCase().replace(/\s+/g, "-");
  const nextTopic = topic.trim() || null;
  // A stage's topic belongs to its live stage (STAGE_INSTANCE), not to the channel.
  const liveStage = useVoice(s => s.stages[channel.id]);
  // null until edited, so a stage that starts or changes its topic while this page is open doesn't look like an unsaved edit.
  const [stageDraft, setStageDraft] = useState<string | null>(null);
  const stageTopic = stageDraft ?? liveStage?.topic ?? "";
  const stageTopicDirty = !!liveStage && stageDraft !== null && !!stageDraft.trim() && stageDraft.trim() !== liveStage.topic;
  // The server wants the stage moderator set (Manage Channels + Mute + Move Members) to edit a live stage, more than Manage Channels.
  const stageModerator = isStageModeratorBits(usePermissions(channel.guild_id, channel.id).bits);
  const hasTopic = !category && !stage;
  const ceiling = useVoiceUi(s => s.bitrateCeiling);
  const savedBitrate = Math.round((channel.bitrate ?? 64000) / 1000);
  const savedLimit = channel.user_limit ?? 0;
  const [bitrateKbps, setBitrateKbps] = useState(savedBitrate);
  const [userLimit, setUserLimit] = useState(savedLimit);
  const voiceDirty = voice && (bitrateKbps !== savedBitrate || userLimit !== savedLimit);
  const slowmodeSupported = channel.type === ChannelType.GuildText || voice;
  const savedSlowmode = channel.rate_limit_per_user ?? 0;
  const [slowmode, setSlowmode] = useState(savedSlowmode);
  const channelDirty = slug !== (channel.name ?? "") || (hasTopic && nextTopic !== (channel.topic ?? null)) || voiceDirty || slowmode !== savedSlowmode;
  const dirty = channelDirty || stageTopicDirty;

  const formatTopic = (marker: string) => {
    const box = topicRef.current;
    if (!box) return;
    const next = toggleWrap(topic, { start: box.selectionStart, end: box.selectionEnd }, marker);
    if (next.value.length > TOPIC_MAX) return;
    setSaved(false);
    setTopic(next.value);
    requestAnimationFrame(() => {
      box.focus();
      box.setSelectionRange(next.start, next.end);
    });
  };

  const reset = () => {
    setName(channel.name ?? "");
    setTopic(channel.topic ?? "");
    setStageDraft(null);
    setBitrateKbps(savedBitrate);
    setUserLimit(savedLimit);
    setSlowmode(savedSlowmode);
    setError(null);
  };
  // The channel PATCH and the live stage's topic are separate requests: each runs only if its own fields changed, and a failure of one
  // keeps the other's result (a stage that ended before Save, or a missing moderator permission, must not undo a rename).
  const save = async () => {
    if (!slug) return;
    setBusy(true);
    setError(null);
    const voiceBody = voice ? { bitrate: bitrateKbps * 1000, user_limit: userLimit } : {};
    const slowmodeBody = slowmodeSupported ? { rate_limit_per_user: slowmode } : {};
    let failure: unknown = null;
    if (stageTopicDirty) {
      try {
        await editStageTopic(channel.id, stageTopic);
        setStageDraft(null);
      } catch (e) {
        failure = e;
      }
    }
    if (!channelDirty) {
      if (failure) setError(errorText(failure));
      else setSaved(true);
      setBusy(false);
      return;
    }
    await request<Channel>("PATCH", `/channels/${channel.id}`, { name: slug, ...(hasTopic ? { topic: nextTopic } : {}), ...voiceBody, ...slowmodeBody })
      .then(updated => {
        appStore.getState().upsertChannel(updated);
        setName(updated.name ?? slug);
        setTopic(updated.topic ?? "");
        setSlowmode(updated.rate_limit_per_user ?? 0);
        if (voice) {
          setBitrateKbps(Math.round((updated.bitrate ?? 64000) / 1000));
          setUserLimit(updated.user_limit ?? 0);
        }
        if (!failure) setSaved(true);
      })
      .catch(e => (failure = e))
      .finally(() => {
        if (failure) setError(errorText(failure));
        setBusy(false);
      });
  };

  return (
    <Page title="Overview">
      {!editable && <Unavailable>You need the Manage Channel permission to edit this {category ? "category" : "channel"}.</Unavailable>}
      <Field label={category ? "Category Name" : "Channel Name"}>
        <div className="input-prefixed">
          {!category && (voice ? <Volume2 size={16} /> : stage ? <Radio size={16} /> : <Hash size={16} />)}
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
      {stage && (
        <Field label="Stage Topic" note={!liveStage ? "Shown while the stage is live. Start the stage from its channel to set one." : stageModerator ? undefined : "Editing a live stage needs Manage Channels, Mute Members and Move Members."}>
          <input
            className="input"
            aria-label="Stage topic"
            value={stageTopic}
            maxLength={STAGE_TOPIC_MAX_CHARS}
            disabled={!editable || !stageModerator || !liveStage}
            onChange={e => {
              setSaved(false);
              setStageDraft(e.target.value);
            }}
          />
        </Field>
      )}
      {hasTopic && (
        <Field label="Channel Topic">
          <div className="cs-rich">
            <div className="cs-rich-toolbar" role="toolbar" aria-label="Topic formatting">
              {TOPIC_FORMATS.map(({ label, marker, className, text }) => (
                <button
                  key={marker}
                  type="button"
                  className={`cs-rich-btn ${className}`}
                  aria-label={label}
                  title={label}
                  disabled={!editable}
                  // keep the textarea's selection
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => formatTopic(marker)}
                >
                  {text ?? <Eye size={16} aria-hidden="true" />}
                </button>
              ))}
            </div>
            <textarea
              ref={topicRef}
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
      {!category && (
        <>
          {slowmodeSupported && (
            <Field label="Slowmode" note="Members are restricted to sending one message per this interval, unless they have the Bypass Slowmode, Manage Channel or Manage Messages permission.">
              <Select<string>
                label="Slowmode"
                value={String(slowmode)}
                options={(SLOWMODE_CHOICES as readonly number[]).concat(SLOWMODE_CHOICES.some(c => c === slowmode) ? [] : [slowmode]).map(value => ({ value: String(value), label: slowmodeLabel(value) }))}
                disabled={!editable}
                onChange={v => {
                  setSaved(false);
                  setSlowmode(Number(v));
                }}
              />
            </Field>
          )}
          {!stage && <Field label="Content Visibility" note="Not available yet.">
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
          </Field>}
          {!voice && !stage && (
            <Field label="Hide After Inactivity" note="Not available yet.">
              <LockedSelect label="Hide after inactivity" value="3 Days" />
            </Field>
          )}
        </>
      )}
      {voice && (
        <>
          <Divider />
          <Field label="Bitrate" note={bitrateKbps > 64 ? "Over 64 kbps may hurt people with a bad connection. 64 kbps is the recommended default." : "64 kbps is the recommended default."}>
            <Slider
              label="Bitrate"
              min={8}
              max={Math.round(ceiling / 1000)}
              value={Math.min(bitrateKbps, Math.round(ceiling / 1000))}
              disabled={!editable}
              format={v => `${v} kbps`}
              onChange={v => {
                setSaved(false);
                setBitrateKbps(v);
              }}
            />
          </Field>
          <Field label="Video Quality" note="Not available yet: each camera sends the resolution its owner picked in Voice &amp; Video settings.">
            <RadioGroup<string>
              name="Video quality"
              value="auto"
              disabled
              options={[
                { value: "auto", label: "Auto", note: "Vokko picks the best quality for each viewer." },
                { value: "720p", label: "720p", note: "Always 720p." },
              ]}
              onChange={() => undefined}
            />
          </Field>
          <Divider />
          <Field label="User Limit" note="Members with the Move Members permission can still join a full channel.">
            <Slider
              label="User limit"
              min={0}
              max={99}
              value={userLimit}
              disabled={!editable}
              format={v => (v === 0 ? "No limit" : String(v))}
              onChange={v => {
                setSaved(false);
                setUserLimit(v);
              }}
            />
          </Field>
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
  const isStage = channel?.type === ChannelType.GuildStage;
  const sections = isCategory
    ? SECTIONS.filter(s => s.id === "overview" || s.id === "permissions")
    : SECTIONS.filter(s => (s.id !== "forum" || isForum) && !(isStage && s.id === "integrations")); // webhooks can't post into a stage
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
            <InviteList guildId={guild.id} channelId={channel.id} canManage={canManage} />
          </Page>
        );
      case "integrations":
        return <ChannelIntegrations channel={channel} canManageWebhooks={can(Perm.MANAGE_WEBHOOKS)} />;
    }
  };

  const eyebrow = category ? (
    channel.name
  ) : (
    <span className="cs-header-name">
      {privateChannel ? <Lock size={12} aria-hidden="true" /> : channel.type === ChannelType.GuildVoice ? <Volume2 size={12} aria-hidden="true" /> : isStage ? <Radio size={12} aria-hidden="true" /> : <Hash size={12} aria-hidden="true" />}
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
      startOnPage={section !== undefined}
      label="Channel Settings"
      navLabel="Channel settings sections"
      eyebrow={eyebrow}
      eyebrowTitle={channel.name ?? undefined}
      groups={groups}
      current={current}
      // A visible save bar refuses the switch / close and shakes instead (settings/unsaved.ts), like in User Settings.
      onSelect={id => {
        if (id !== current && blockedByUnsaved()) return;
        setCurrent(id as SectionId);
      }}
      onClose={() => {
        if (!blockedByUnsaved()) closeModal();
      }}
    >
      {page()}
    </FullScreenSettings>
  );
}
