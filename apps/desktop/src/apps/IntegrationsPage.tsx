// Server Settings > Integrations (bots and webhooks) and Channel Settings > Integrations (that channel's webhooks and followed channels).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, ChevronRight, Copy, Megaphone, Trash2, Webhook as WebhookIcon } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { listFollowers, unfollowChannel, uploadAttachment } from "../api/rest";
import { useStore } from "../api/store";
import { ChannelType, type Channel, type ChannelFollower, type Guild, type GuildIntegration, type Snowflake, type Webhook } from "../api/types";
import { Modal } from "../ui";
import { Avatar } from "../chat/Avatar";
import { Category, Page } from "../shell/settings/controls";
import { SaveBar } from "../shell/settings/SaveBar";
import { createWebhook, deleteWebhook, editWebhook, listChannelWebhooks, listGuildWebhooks, listIntegrations, removeIntegration } from "./api";
import { AppIcon } from "./AppIcon";
import { bindAppsGateway, useAppsStore } from "./store";
import "./apps.css";

function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "Something went wrong. Try again.";
}

const acceptsWebhooks = (channel: Channel) => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement;

function useCopied(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  return [
    copied,
    (key, text) => {
      void navigator.clipboard?.writeText(text);
      setCopied(key);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), 1500);
    },
  ];
}

/** One webhook, collapsed to a row; expanded it edits name, avatar and channel, copies the URL and deletes it. */
function WebhookCard({ hook, channels, onChanged, defaultOpen }: { hook: Webhook; channels: Channel[]; onChanged(): void; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [name, setName] = useState(hook.name);
  const [channelId, setChannelId] = useState(hook.channel_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, copy] = useCopied();
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setName(hook.name);
    setChannelId(hook.channel_id);
  }, [hook.name, hook.channel_id]);
  const dirty = name.trim() !== hook.name || channelId !== hook.channel_id;
  const channel = channels.find(c => c.id === hook.channel_id);

  const save = async (body: Parameters<typeof editWebhook>[1]) => {
    setBusy(true);
    setError(null);
    try {
      await editWebhook(hook.id, body);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const uploadAvatar = async (picked: File | undefined) => {
    if (!picked) return;
    setBusy(true);
    try {
      const attachment = await uploadAttachment(hook.channel_id, picked);
      await save({ avatar_attachment_id: attachment.id });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <li className={`apps-card${open ? " open" : ""}`} data-webhook-id={hook.id}>
      <button type="button" className="apps-card-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <Avatar user={{ id: hook.id, avatar: hook.avatar }} size={32} />
        <span className="apps-card-title">
          <span className="apps-card-name">{hook.name}</span>
          <span className="apps-card-sub">
            {channel ? `#${channel.name}` : "Unknown channel"}
            {hook.user ? ` · Created by ${hook.user.global_name ?? hook.user.username}` : ""}
          </span>
        </span>
        {open ? <ChevronDown size={18} aria-hidden="true" /> : <ChevronRight size={18} aria-hidden="true" />}
      </button>
      {open && (
        <div className="apps-card-body">
          <div className="apps-webhook-edit">
            <button type="button" className="apps-avatar-pick" aria-label="Change webhook avatar" disabled={busy} onClick={() => file.current?.click()}>
              <Avatar user={{ id: hook.id, avatar: hook.avatar }} size={80} />
              <span>Change</span>
            </button>
            <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={e => void uploadAvatar(e.target.files?.[0])} />
            <div className="apps-webhook-fields">
              <label className="field-label" htmlFor={`hook-name-${hook.id}`}>
                Name
              </label>
              <input id={`hook-name-${hook.id}`} className="input" value={name} maxLength={80} onChange={e => setName(e.target.value)} />
              <label className="field-label" htmlFor={`hook-channel-${hook.id}`}>
                Channel
              </label>
              <select id={`hook-channel-${hook.id}`} className="select" value={channelId} onChange={e => setChannelId(e.target.value)}>
                {channels.filter(acceptsWebhooks).map(c => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {error && !dirty && <p className="field-error">{error}</p>}
          <div className="apps-card-actions">
            <button type="button" className="btn btn-secondary btn-sm" disabled={!hook.url} onClick={() => hook.url && copy("url", hook.url)}>
              <Copy size={14} aria-hidden="true" /> {copied === "url" ? "Copied!" : "Copy Webhook URL"}
            </button>
            <button type="button" className="btn-link apps-danger-link" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={14} aria-hidden="true" /> Delete Webhook
            </button>
          </div>
        </div>
      )}
      {/* Outside the open body: collapsing a card keeps its draft, so the bar (and the guard) must stay. */}
      <SaveBar
        visible={dirty}
        busy={busy}
        error={error}
        saveDisabled={!name.trim()}
        onReset={() => (setName(hook.name), setChannelId(hook.channel_id))}
        onSave={() => void save({ ...(name.trim() !== hook.name ? { name: name.trim() } : {}), ...(channelId !== hook.channel_id ? { channel_id: channelId } : {}) })}
      />
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${hook.name}`}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await deleteWebhook(hook.id);
                  setConfirmDelete(false);
                  onChanged();
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete
            </button>
          </>
        }
      >
        <p>Anything using this webhook URL will stop working. This cannot be undone.</p>
      </Modal>
    </li>
  );
}

/** Webhooks of a guild (`channelId` narrows to one channel) with "New Webhook". */
export function WebhooksSection({ guildId, channelId }: { guildId: Snowflake; channelId?: Snowflake }) {
  const allChannels = useStore(s => s.channels);
  const channels = useMemo(() => Object.values(allChannels).filter(c => c.guild_id === guildId).sort((a, b) => a.position - b.position), [allChannels, guildId]);
  const version = useAppsStore(s => s.webhookVersion[channelId ?? guildId] ?? 0);
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setHooks(channelId ? await listChannelWebhooks(channelId) : await listGuildWebhooks(guildId));
      setError(null);
    } catch (e) {
      setError(errorText(e));
      setHooks(current => current ?? []);
    }
  }, [guildId, channelId]);

  useEffect(() => {
    bindAppsGateway();
    void load();
  }, [load, version]);

  const target = channelId ?? channels.find(acceptsWebhooks)?.id;
  const create = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const hook = await createWebhook(target, { name: "New Webhook" });
      setCreated(hook.id);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Category title="Webhooks">
      <p className="settings-todo">Webhooks post messages from other services into a channel, with their own name and avatar.</p>
      <div className="apps-toolbar">
        <button type="button" className="btn btn-sm" disabled={busy || !target} onClick={() => void create()}>
          <WebhookIcon size={14} aria-hidden="true" /> New Webhook
        </button>
      </div>
      {error && <p className="field-error">{error}</p>}
      {hooks === null && <p className="settings-todo">Loading…</p>}
      {hooks !== null && hooks.length === 0 && <p className="settings-todo">No webhooks yet.</p>}
      {hooks !== null && hooks.length > 0 && (
        <ul className="apps-card-list" aria-label="Webhooks">
          {hooks.map(hook => (
            <WebhookCard key={hook.id} hook={hook} channels={channels} onChanged={() => void load()} defaultOpen={hook.id === created} />
          ))}
        </ul>
      )}
    </Category>
  );
}

/** Bots added to the server, with who added them and Remove. */
function BotsSection({ guild, onOpenRoles }: { guild: Guild; onOpenRoles?: () => void }) {
  const [rows, setRows] = useState<GuildIntegration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<GuildIntegration | null>(null);
  const [busy, setBusy] = useState(false);
  const memberCount = useStore(s => Object.keys(s.members[guild.id] ?? {}).length);

  const load = useCallback(async () => {
    try {
      setRows(await listIntegrations(guild.id));
      setError(null);
    } catch (e) {
      setError(errorText(e));
      setRows(current => current ?? []);
    }
  }, [guild.id]);
  useEffect(() => {
    void load();
  }, [load, memberCount]);

  return (
    <Category title="Bots and Apps">
      {error && <p className="field-error">{error}</p>}
      {rows === null && <p className="settings-todo">Loading…</p>}
      {rows !== null && rows.length === 0 && <p className="settings-todo">No apps have been added to this server. Use an app&rsquo;s invite link to add it.</p>}
      {rows !== null && rows.length > 0 && (
        <ul className="apps-card-list" aria-label="Bots">
          {rows.map(row => {
            const role = guild.roles.find(r => r.id === row.role_id);
            return (
              <li key={row.id} className="apps-card">
                <div className="apps-card-head static">
                  <AppIcon name={row.name} icon={row.application.icon} size={32} />
                  <span className="apps-card-title">
                    <span className="apps-card-name">
                      {row.name} <span className="chat-bot-tag apps-tag">APP</span>
                    </span>
                    <span className="apps-card-sub">
                      {row.user ? `Added by ${row.user.global_name ?? row.user.username}` : "Added"}
                      {role ? ` · Role @${role.name}` : ""}
                    </span>
                  </span>
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => setRemoving(row)}>
                    <Bot size={14} aria-hidden="true" /> Remove
                  </button>
                </div>
                <p className="apps-card-access">
                  Who can talk to {row.name}: members with Use Application Commands, set in{" "}
                  {onOpenRoles ? (
                    <button type="button" className="apps-link" onClick={onOpenRoles}>
                      Roles
                    </button>
                  ) : (
                    "Roles"
                  )}{" "}
                  or channel Permissions.
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <Modal
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={removing ? `Remove ${removing.name}` : ""}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setRemoving(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={async () => {
                if (!removing) return;
                setBusy(true);
                try {
                  await removeIntegration(guild.id, removing.id);
                  setRemoving(null);
                  await load();
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove
            </button>
          </>
        }
      >
        <p>The bot leaves the server, its role and its server commands are deleted.</p>
      </Modal>
    </Category>
  );
}

export function IntegrationsPage({ guild, canManageGuild, canManageWebhooks, onOpenRoles }: { guild: Guild; canManageGuild: boolean; canManageWebhooks: boolean; onOpenRoles?: () => void }) {
  return (
    <Page title="Integrations">
      {canManageWebhooks && <WebhooksSection guildId={guild.id} />}
      {canManageGuild && <BotsSection guild={guild} onOpenRoles={onOpenRoles} />}
    </Page>
  );
}

/** Announcement channels this channel follows (their published posts land here), each with Unfollow. */
function FollowedChannelsSection({ channelId }: { channelId: Snowflake }) {
  const [rows, setRows] = useState<ChannelFollower[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    listFollowers(channelId).then(setRows, e => {
      setRows([]);
      setError(errorText(e));
    });
  }, [channelId]);
  useEffect(load, [load]);
  const unfollow = (id: Snowflake) => {
    setError(null);
    unfollowChannel(channelId, id).then(load, e => setError(errorText(e)));
  };
  return (
    <Category title="Followed Channels">
      <p className="settings-todo">Posts published in these announcement channels show up here.</p>
      {error && <p className="field-error">{error}</p>}
      {rows === null && <p className="settings-todo">Loading…</p>}
      {rows !== null && rows.length === 0 && <p className="settings-todo">This channel doesn&rsquo;t follow any announcement channels. Use Follow in an announcement channel to add one.</p>}
      {rows !== null && rows.length > 0 && (
        <ul className="apps-card-list" aria-label="Followed channels">
          {rows.map(row => (
            <li key={row.id} className="apps-card">
              <div className="apps-card-head static">
                <Megaphone size={20} aria-hidden="true" />
                <span className="apps-card-title">
                  <span className="apps-card-name">#{row.source_channel_name}</span>
                  <span className="apps-card-sub">{row.source_guild_name}</span>
                </span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => unfollow(row.id)}>
                  Unfollow
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Category>
  );
}

export function ChannelIntegrations({ channel, canManageWebhooks }: { channel: Channel; canManageWebhooks: boolean }) {
  return (
    <Page title="Integrations">
      {channel.guild_id && canManageWebhooks && acceptsWebhooks(channel) ? (
        <WebhooksSection guildId={channel.guild_id} channelId={channel.id} />
      ) : (
        <Category title="Webhooks">
          <p className="settings-todo">{acceptsWebhooks(channel) ? "You need the Manage Webhooks permission." : "This channel type has no webhooks."}</p>
        </Category>
      )}
      {channel.guild_id && canManageWebhooks && acceptsWebhooks(channel) ? (
        <FollowedChannelsSection channelId={channel.id} />
      ) : (
        <Category title="Followed Channels">
          <p className="settings-todo">{acceptsWebhooks(channel) ? "You need the Manage Webhooks permission." : "Only text and announcement channels can follow announcement channels."}</p>
        </Category>
      )}
    </Page>
  );
}
