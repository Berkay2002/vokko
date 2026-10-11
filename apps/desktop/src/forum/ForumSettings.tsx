import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { editChannel } from "../api/rest";
import { appStore } from "../api/store";
import { ChannelFlags, ForumLayout, ForumSortOrder, type Channel, type ForumTagRequest, type ThreadAutoArchiveDuration } from "../api/types";
import { Category, Field, Page, Select, Toggle, Unavailable } from "../shell/settings/controls";
import { SaveBar } from "../shell/settings/SaveBar";
import { ARCHIVE_OPTIONS } from "../threads/util";
import "./forum.css";

const MAX_TAGS = 20;
const TAG_NAME_MAX = 20;

interface TagRow {
  /** Absent for a tag that has not been saved yet. */
  id?: string;
  name: string;
  emoji: string;
  moderated: boolean;
  key: number;
}

const rowsOf = (channel: Channel): TagRow[] => (channel.available_tags ?? []).map((t, key) => ({ id: t.id, name: t.name, emoji: t.emoji_name ?? "", moderated: t.moderated, key }));
const toRequest = (rows: TagRow[]): ForumTagRequest[] => rows.map(r => ({ ...(r.id ? { id: r.id } : {}), name: r.name.trim(), moderated: r.moderated, emoji_id: null, emoji_name: r.emoji.trim() || null }));

/** Forum section of the channel settings: tags, default sort and layout, default reaction, "require a tag" and the default auto-archive. */
export function ForumSettingsPage({ channel, editable }: { channel: Channel; editable: boolean }) {
  const [rows, setRows] = useState<TagRow[]>(() => rowsOf(channel));
  const [sort, setSort] = useState(String(channel.default_sort_order ?? ForumSortOrder.LatestActivity));
  const [layout, setLayout] = useState(String(channel.default_forum_layout === ForumLayout.Gallery ? ForumLayout.Gallery : ForumLayout.List));
  const [reaction, setReaction] = useState(channel.default_reaction_emoji?.emoji_name ?? "");
  const [requireTag, setRequireTag] = useState(((channel.flags ?? 0) & ChannelFlags.RequireTag) !== 0);
  const [archive, setArchive] = useState(String(channel.default_auto_archive_duration ?? 1440));
  const [next, setNext] = useState(() => rows.length);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const original = {
    tags: JSON.stringify(toRequest(rowsOf(channel))),
    sort: String(channel.default_sort_order ?? ForumSortOrder.LatestActivity),
    layout: String(channel.default_forum_layout === ForumLayout.Gallery ? ForumLayout.Gallery : ForumLayout.List),
    reaction: channel.default_reaction_emoji?.emoji_name ?? "",
    requireTag: ((channel.flags ?? 0) & ChannelFlags.RequireTag) !== 0,
    archive: String(channel.default_auto_archive_duration ?? 1440),
  };
  const namesOk = rows.every(r => r.name.trim().length > 0);
  const dirty = JSON.stringify(toRequest(rows)) !== original.tags || sort !== original.sort || layout !== original.layout || reaction.trim() !== original.reaction || requireTag !== original.requireTag || archive !== original.archive;

  const reset = () => {
    setRows(rowsOf(channel));
    setSort(original.sort);
    setLayout(original.layout);
    setReaction(original.reaction);
    setRequireTag(original.requireTag);
    setArchive(original.archive);
    setError(null);
  };

  const save = () => {
    if (!namesOk) {
      setError("Every tag needs a name.");
      return;
    }
    setBusy(true);
    setError(null);
    editChannel(channel.id, {
      available_tags: toRequest(rows),
      default_sort_order: Number(sort) as ForumSortOrder,
      default_forum_layout: Number(layout) as ForumLayout,
      default_reaction_emoji: reaction.trim() ? { emoji_id: null, emoji_name: reaction.trim() } : null,
      default_auto_archive_duration: Number(archive) as ThreadAutoArchiveDuration,
      flags: ((channel.flags ?? 0) & ~ChannelFlags.RequireTag) | (requireTag ? ChannelFlags.RequireTag : 0),
    })
      .then(updated => {
        appStore.getState().upsertChannel(updated);
        setRows(rowsOf(updated));
      })
      .catch(e => setError(e instanceof ApiRequestError ? e.message : "Something went wrong. Try again."))
      .finally(() => setBusy(false));
  };

  const patchRow = (key: number, change: Partial<TagRow>) => setRows(list => list.map(r => (r.key === key ? { ...r, ...change } : r)));

  return (
    <Page title="Forum">
      {!editable && <Unavailable>You need the Manage Channel permission to change this forum.</Unavailable>}
      <Category title="Tags">
        <p className="settings-todo">Members tag their posts with these (up to five per post). A moderated tag can only be used by people who can manage threads.</p>
        <div className="forum-tag-rows">
          {rows.map(row => (
            <div key={row.key} className="forum-tag-row">
              <input className="input forum-tag-emoji" aria-label="Tag emoji" value={row.emoji} maxLength={8} placeholder="🙂" disabled={!editable} onChange={e => patchRow(row.key, { emoji: e.target.value })} />
              <input className="input forum-tag-name" aria-label="Tag name" value={row.name} maxLength={TAG_NAME_MAX} placeholder="Tag name" disabled={!editable} onChange={e => patchRow(row.key, { name: e.target.value })} />
              <span className="forum-tag-moderated">
                <Toggle checked={row.moderated} label={`Moderated: ${row.name || "tag"}`} disabled={!editable} onChange={moderated => patchRow(row.key, { moderated })} />
                <span>Moderated</span>
              </span>
              <button type="button" className="icon-button" aria-label={`Remove tag ${row.name}`} disabled={!editable} onClick={() => setRows(list => list.filter(r => r.key !== row.key))}>
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!editable || rows.length >= MAX_TAGS}
          onClick={() => {
            setRows(list => [...list, { name: "", emoji: "", moderated: false, key: next }]);
            setNext(n => n + 1);
          }}
        >
          <Plus size={16} aria-hidden="true" /> Add Tag
        </button>
      </Category>
      <Category title="Posts">
        <div className="switch-row">
          <div className="switch-row-text">
            <div className="switch-row-label">Require Tag</div>
            <div className="switch-row-note">New posts need at least one tag.</div>
          </div>
          <Toggle checked={requireTag} onChange={setRequireTag} label="Require tag" disabled={!editable} />
        </div>
        <Field label="Default Sort Order">
          <Select<string>
            label="Default sort order"
            value={sort}
            disabled={!editable}
            options={[
              { value: String(ForumSortOrder.LatestActivity), label: "Recent Activity" },
              { value: String(ForumSortOrder.CreationDate), label: "Date Posted" },
            ]}
            onChange={setSort}
          />
        </Field>
        <Field label="Default Layout">
          <Select<string>
            label="Default layout"
            value={layout}
            disabled={!editable}
            options={[
              { value: String(ForumLayout.List), label: "List View" },
              { value: String(ForumLayout.Gallery), label: "Gallery View" },
            ]}
            onChange={setLayout}
          />
        </Field>
        <Field label="Default Reaction Emoji" note="Shown as a quick reaction on new posts. Leave empty for none.">
          <input className="input forum-tag-emoji" aria-label="Default reaction emoji" value={reaction} maxLength={8} placeholder="👍" disabled={!editable} onChange={e => setReaction(e.target.value)} />
        </Field>
        <Field label="Hide After Inactivity" note="Posts without a new message for this long are archived.">
          <Select<string> label="Hide after inactivity" value={archive} disabled={!editable} options={ARCHIVE_OPTIONS} onChange={setArchive} />
        </Field>
      </Category>
      <SaveBar visible={editable && (dirty || !!error)} busy={busy} error={error} onReset={reset} onSave={save} />
    </Page>
  );
}
