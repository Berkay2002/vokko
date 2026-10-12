// Discord's "Invite friends to <server>" modal: friends with Invite buttons (the link goes out as a DM), the copyable link and the
// "Edit invite link" settings (expire after, max uses, temporary membership).

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Hash, Volume2 } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { displayName, useStore } from "../api/store";
import { ChannelType, RelationshipType, type InviteMetadata, type Relationship, type Snowflake } from "../api/types";
import { Modal } from "../ui";
import { Avatar } from "../shell/Avatar";
import { Select, SwitchRow } from "../shell/settings/controls";
import { DEFAULT_INVITE_SETTINGS, MAX_AGE_OPTIONS, MAX_USES_OPTIONS, createInvite, expiryText, inviteLink, sendInviteToFriend, type InviteSettings } from "./api";
import "./invites.css";

function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "Something went wrong. Try again.";
}

type SendState = "sending" | "sent" | "failed";

function FriendRow({ relationship, state, disabled, onInvite }: { relationship: Relationship; state: SendState | undefined; disabled: boolean; onInvite: () => void }) {
  const name = displayName(relationship.user);
  return (
    <li className="invite-friend">
      <Avatar user={relationship.user} size={32} />
      <span className="invite-friend-text">
        <span className="invite-friend-name">{name}</span>
        <span className="invite-friend-username">{relationship.user.username}</span>
      </span>
      <button
        type="button"
        className={`btn btn-sm invite-friend-button${state === "sent" ? " sent" : ""}`}
        disabled={disabled || state === "sending" || state === "sent"}
        aria-label={`${state === "sent" ? "Invite sent to" : "Invite"} ${name}`}
        onClick={onInvite}
      >
        {state === "sent" ? "Sent" : state === "failed" ? "Retry" : "Invite"}
      </button>
    </li>
  );
}

function LinkSettings({ initial, busy, error, onCancel, onSubmit }: { initial: InviteSettings; busy: boolean; error: string | null; onCancel: () => void; onSubmit: (settings: InviteSettings) => void }) {
  const [settings, setSettings] = useState(initial);
  return (
    <>
      <div className="invite-settings">
        <div className="settings-field">
          <div className="field-label">Expire After</div>
          <Select label="Expire After" value={String(settings.maxAge)} options={MAX_AGE_OPTIONS.map(o => ({ value: String(o.value), label: o.label }))} onChange={v => setSettings({ ...settings, maxAge: Number(v) as InviteSettings["maxAge"] })} />
        </div>
        <div className="settings-field">
          <div className="field-label">Max Number of Uses</div>
          <Select label="Max Number of Uses" value={String(settings.maxUses)} options={MAX_USES_OPTIONS.map(o => ({ value: String(o.value), label: o.label }))} onChange={v => setSettings({ ...settings, maxUses: Number(v) as InviteSettings["maxUses"] })} />
        </div>
        <SwitchRow
          label="Grant temporary membership"
          note="Temporary members are removed when they disconnect, unless a role has been assigned."
          checked={settings.temporary}
          onChange={temporary => setSettings({ ...settings, temporary })}
        />
      </div>
      {error && <p className="field-error">{error}</p>}
      <div className="invite-settings-actions">
        <button type="button" className="btn btn-link" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onSubmit(settings)}>
          Generate a New Link
        </button>
      </div>
    </>
  );
}

export function InviteModal({ channelId, onClose }: { channelId: Snowflake; onClose: () => void }) {
  const channel = useStore(s => s.channels[channelId]);
  const guild = useStore(s => (channel?.guild_id ? s.guilds[channel.guild_id] : undefined));
  const relationships = useStore(s => s.relationships);
  const [settings, setSettings] = useState<InviteSettings>(DEFAULT_INVITE_SETTINGS);
  const [invite, setInvite] = useState<InviteMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [sent, setSent] = useState<Record<Snowflake, SendState>>({});

  useEffect(() => {
    let live = true;
    createInvite(channelId, DEFAULT_INVITE_SETTINGS)
      .then(i => live && setInvite(i))
      .catch(e => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [channelId]);

  const friends = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return Object.values(relationships)
      .filter(r => r.type === RelationshipType.Friend)
      .filter(r => !needle || r.user.username.includes(needle) || displayName(r.user).toLowerCase().includes(needle))
      .sort((a, b) => displayName(a.user).localeCompare(displayName(b.user)));
  }, [relationships, query]);

  const regenerate = async (next: InviteSettings) => {
    setBusy(true);
    setError(null);
    try {
      setInvite(await createInvite(channelId, next, true));
      setSettings(next);
      setSent({});
      setEditing(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const inviteFriend = async (userId: Snowflake) => {
    if (!invite) return;
    setSent(current => ({ ...current, [userId]: "sending" }));
    try {
      await sendInviteToFriend(userId, invite.code);
      setSent(current => ({ ...current, [userId]: "sent" }));
    } catch {
      setSent(current => ({ ...current, [userId]: "failed" }));
    }
  };

  const link = invite ? inviteLink(invite.code) : "";
  const title = editing ? "Server invite link settings" : guild ? `Invite friends to ${guild.name}` : "Invite friends";

  return (
    <Modal open onClose={onClose} title={title} className="invite-modal" sheet>
      {editing ? (
        <LinkSettings initial={settings} busy={busy} error={error} onCancel={() => setEditing(false)} onSubmit={next => void regenerate(next)} />
      ) : (
        <>
          <p className="modal-subtle">
            Recipients will land in {channel?.type === ChannelType.GuildVoice ? <Volume2 size={14} className="inline-icon" /> : <Hash size={14} className="inline-icon" />} {channel?.name}
          </p>
          <input className="input invite-search" type="search" value={query} placeholder="Search for friends" aria-label="Search for friends" onChange={e => setQuery(e.target.value)} />
          {friends.length > 0 ? (
            <ul className="invite-friends" aria-label="Friends">
              {friends.map(r => (
                <FriendRow key={r.id} relationship={r} state={sent[r.id]} disabled={!invite} onInvite={() => void inviteFriend(r.id)} />
              ))}
            </ul>
          ) : (
            <p className="modal-subtle invite-no-friends">{query.trim() ? "No friends match your search." : "No friends to invite yet."}</p>
          )}
          <label className="field-label invite-link-label" htmlFor="invite-link">
            Or, send a server invite link to a friend
          </label>
          <div className="copy-field">
            <input id="invite-link" className="input invite-secret" readOnly value={invite ? link : error ? "" : "Generating…"} onFocus={e => e.currentTarget.select()} />
            <button
              type="button"
              className={`btn ${copied ? "btn-success" : "btn-primary"}`}
              disabled={!invite}
              onClick={() => {
                void navigator.clipboard?.writeText(link);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? (
                <>
                  <Check size={16} /> Copied
                </>
              ) : (
                <>
                  <Copy size={16} /> Copy
                </>
              )}
            </button>
          </div>
          <p className="modal-subtle">
            {expiryText(settings)}{" "}
            <button type="button" className="link-button" onClick={() => setEditing(true)}>
              Edit invite link.
            </button>
          </p>
          {error && <p className="field-error">{error}</p>}
        </>
      )}
    </Modal>
  );
}
