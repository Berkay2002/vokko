import { useState } from "react";
import { ApiRequestError } from "../api/errors";
import { startForumPost } from "../api/rest";
import { ChannelFlags, type Channel } from "../api/types";
import { openThread } from "../threads/threadUi";
import { NAME_MAX } from "../threads/util";
import { TagChip } from "./ForumPostCard";
import "./forum.css";

const MAX_TAGS = 5;
const MESSAGE_MAX = 2000;

/**
 * Create-post composer: the forum's post guidelines, title, up to five tags (moderated ones only with Manage Threads; at least one when the
 * forum requires tags), first message. Opens the new post in the thread panel.
 */
export function NewPostForm({ forum, canModerateTags, onClose }: { forum: Channel; canModerateTags: boolean; onClose(): void }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = forum.available_tags ?? [];
  const requireTag = ((forum.flags ?? 0) & ChannelFlags.RequireTag) !== 0;
  const ready = title.trim() !== "" && content.trim() !== "" && (!requireTag || tags.length > 0) && content.length <= MESSAGE_MAX;

  const toggle = (id: string) => setTags(current => (current.includes(id) ? current.filter(t => t !== id) : current.length < MAX_TAGS ? [...current, id] : current));

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const post = await startForumPost(forum.id, { name: title.trim(), applied_tags: tags, message: { content: content.trim() } });
      onClose();
      openThread(post);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not create the post. Try again.");
      setBusy(false);
    }
  }

  return (
    <form
      className="forum-new"
      aria-label="New post"
      onSubmit={e => {
        e.preventDefault();
        void submit();
      }}
    >
      {forum.topic && (
        <section className="forum-new-guidelines" aria-label="Post guidelines for this forum">
          <h3>Post Guidelines</h3>
          <p>{forum.topic}</p>
        </section>
      )}
      <input className="input forum-new-title" aria-label="Post title" value={title} maxLength={NAME_MAX} autoFocus placeholder="Post title" onChange={e => setTitle(e.target.value)} />
      {available.length > 0 && (
        <div className="forum-new-tags" role="group" aria-label={requireTag ? "Tags (at least one required)" : "Tags"}>
          <span className="forum-new-label">{requireTag ? "Tags (required)" : "Tags"}</span>
          {available.map(tag => (
            <span key={tag.id} className={tag.moderated && !canModerateTags ? "forum-tag-wrap disabled" : "forum-tag-wrap"} title={tag.moderated && !canModerateTags ? "Only moderators can use this tag" : undefined}>
              <TagChip tag={tag} selected={tags.includes(tag.id)} onClick={tag.moderated && !canModerateTags ? () => undefined : () => toggle(tag.id)} />
            </span>
          ))}
          {requireTag && tags.length === 0 && <span className="forum-new-hint">Pick at least one tag to post.</span>}
        </div>
      )}
      <textarea className="forum-new-message" aria-label="Post message" rows={4} value={content} maxLength={MESSAGE_MAX} placeholder="Write the first message" onChange={e => setContent(e.target.value)} />
      <div className="forum-new-footer">
        {error ? <span className="field-error">{error}</span> : <span className="forum-new-count">{MESSAGE_MAX - content.length}</span>}
        <button type="button" className="btn btn-link btn-sm" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!ready || busy}>
          Post
        </button>
      </div>
    </form>
  );
}
