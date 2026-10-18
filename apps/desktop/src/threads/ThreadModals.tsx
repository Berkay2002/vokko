import { useState } from "react";
import { Hash } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { Perm } from "../api/permissions";
import { deleteThread, editChannel, startThread, startThreadFromMessage } from "../api/rest";
import { appStore, useStore } from "../api/store";
import { ChannelFlags, ChannelType, type Channel, type Message, type ThreadAutoArchiveDuration } from "../api/types";
import { Modal } from "../ui";
import { Toggle, Select } from "../shell/settings/controls";
import { usePermissions } from "../shell/usePermissions";
import { TagChip } from "../forum/ForumPostCard";
import { closeThread, openThread, useThreadUi } from "./threadUi";
import { ARCHIVE_OPTIONS, NAME_MAX } from "./util";
import { messagePreview } from "./preview";
import "./threads.css";

function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "Something went wrong. Try again.";
}

const MAX_TAGS = 5;
const durationOf = (value: string): ThreadAutoArchiveDuration => Number(value) as ThreadAutoArchiveDuration;

/** Create Thread: from a message (name defaults to its text) or free-standing in a channel (optionally private). Opens the new thread. */
export function CreateThreadModal({ channelId, message, onClose }: { channelId: string; message: Message | null; onClose(): void }) {
  const channel = useStore(s => s.channels[channelId]);
  const { can } = usePermissions(channel?.guild_id, channelId);
  const [name, setName] = useState(() => message ? messagePreview(message, 50) : "");
  const [duration, setDuration] = useState(String(channel?.default_auto_archive_duration ?? 1440));
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  async function submit() {
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const auto_archive_duration = durationOf(duration);
      const thread = message
        ? await startThreadFromMessage(channelId, message.id, { name: trimmed, auto_archive_duration })
        : await startThread(channelId, { name: trimmed, auto_archive_duration, type: priv ? ChannelType.PrivateThread : undefined });
      onClose();
      openThread(thread);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Create Thread"
      className="modal-compact"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !trimmed} onClick={() => void submit()}>
            Create Thread
          </button>
        </>
      }
    >
      {channel && (
        <p className="modal-subtle thread-modal-parent">
          <Hash size={14} aria-hidden="true" /> {channel.name}
        </p>
      )}
      {message && message.content && <blockquote className="thread-modal-quote">{messagePreview(message, 160)}</blockquote>}
      <label className="field-label" htmlFor="thread-name">
        Thread name
      </label>
      <input id="thread-name" className="input" value={name} maxLength={NAME_MAX} autoFocus placeholder="New Thread" onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && void submit()} />
      <div className="field-label thread-modal-label">Hide after inactivity</div>
      <Select<string> label="Hide after inactivity" value={duration} options={ARCHIVE_OPTIONS} onChange={setDuration} />
      {!message && can(Perm.CREATE_PRIVATE_THREADS) && (
        <div className="switch-row">
          <div className="switch-row-text">
            <div className="switch-row-label">Private Thread</div>
            <div className="switch-row-note">Only people you invite and moderators can see this thread.</div>
          </div>
          <Toggle checked={priv} onChange={setPriv} label="Private thread" />
        </div>
      )}
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}

/** Rename a thread and change its auto-archive duration; a forum post's tags too (owner or MANAGE_THREADS). */
export function EditThreadModal({ thread, onClose }: { thread: Channel; onClose(): void }) {
  const forum = useStore(s => (s.channels[thread.parent_id ?? ""]?.type === ChannelType.GuildForum ? s.channels[thread.parent_id ?? ""] : undefined));
  const canModerateTags = usePermissions(forum?.guild_id, forum?.id).can(Perm.MANAGE_THREADS);
  const available = forum?.available_tags ?? [];
  const requireTag = ((forum?.flags ?? 0) & ChannelFlags.RequireTag) !== 0;
  const savedTags = thread.applied_tags ?? [];
  const [tags, setTags] = useState(savedTags);
  const tagsDirty = tags.length !== savedTags.length || tags.some(t => !savedTags.includes(t));
  const toggleTag = (id: string) => setTags(cur => (cur.includes(id) ? cur.filter(t => t !== id) : cur.length < MAX_TAGS ? [...cur, id] : cur));
  const [name, setName] = useState(thread.name ?? "");
  const [duration, setDuration] = useState(String(thread.thread_metadata?.auto_archive_duration ?? 1440));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const dirty = trimmed !== thread.name || duration !== String(thread.thread_metadata?.auto_archive_duration) || tagsDirty;
  const tagsOk = !requireTag || !tagsDirty || tags.length > 0; // the server checks it only when tags are sent

  async function save() {
    if (!trimmed || !tagsOk || busy) return;
    setBusy(true);
    try {
      const updated = await editChannel(thread.id, { name: trimmed, auto_archive_duration: durationOf(duration), ...(tagsDirty ? { applied_tags: tags } : {}) });
      appStore.getState().upsertThread(updated);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={forum ? "Edit Post" : "Edit Thread"}
      className="modal-compact"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !trimmed || !dirty || !tagsOk} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <label className="field-label" htmlFor="thread-edit-name">
        Thread name
      </label>
      <input id="thread-edit-name" className="input" value={name} maxLength={NAME_MAX} autoFocus onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && void save()} />
      <div className="field-label thread-modal-label">Hide after inactivity</div>
      <Select<string> label="Hide after inactivity" value={duration} options={ARCHIVE_OPTIONS} onChange={setDuration} />
      {available.length > 0 && (
        <>
          <div className="field-label thread-modal-label">{requireTag ? "Tags (at least one required)" : "Tags"}</div>
          <div className="forum-new-tags" role="group" aria-label="Tags">
            {available.map(tag => {
              const locked = tag.moderated && !canModerateTags; // the server refuses adding or removing one without Manage Threads
              return (
                <span key={tag.id} className={locked ? "forum-tag-wrap disabled" : "forum-tag-wrap"} title={locked ? "Only moderators can use this tag" : undefined}>
                  <TagChip tag={tag} selected={tags.includes(tag.id)} onClick={locked ? () => undefined : () => toggleTag(tag.id)} />
                </span>
              );
            })}
          </div>
        </>
      )}
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}

export function DeleteThreadModal({ thread, onClose }: { thread: Channel; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      open
      onClose={onClose}
      title="Delete Thread"
      className="modal-compact"
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              deleteThread(thread.id)
                .then(() => {
                  appStore.getState().removeThread(thread.id);
                  closeThread();
                  onClose();
                })
                .catch(e => {
                  setError(errorText(e));
                  setBusy(false);
                });
            }}
          >
            Delete Thread
          </button>
        </>
      }
    >
      <p>
        Are you sure you want to delete <b>{thread.name}</b>? All of its messages are lost. This cannot be undone.
      </p>
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}

/** Mounted once by the shell: shows the create-thread dialog the message menu, the toolbar and the threads popout ask for. */
export function ThreadDialogs() {
  const create = useThreadUi(s => s.create);
  return create ? <CreateThreadModal key={`${create.channelId}:${create.message?.id ?? ""}`} channelId={create.channelId} message={create.message} onClose={() => useThreadUi.setState({ create: null })} /> : null;
}
