import { Archive, Lock, MessageSquareText, Pin } from "lucide-react";
import { resolveUrl } from "../api/rest";
import { displayName, useStore } from "../api/store";
import type { Channel, ForumTag, Message } from "../api/types";
import { Avatar } from "../shell/Avatar";
import { isPinned, lastActivityMs, previewText, timeAgo } from "../threads/util";
import "./forum.css";

export function TagChip({ tag, selected, onClick }: { tag: ForumTag; selected?: boolean; onClick?: () => void }) {
  const inner = (
    <>
      {tag.emoji_name && <span aria-hidden="true">{tag.emoji_name}</span>}
      {tag.name}
    </>
  );
  if (!onClick) return <span className="forum-tag static">{inner}</span>;
  return (
    <button type="button" className={`forum-tag${selected ? " selected" : ""}`} aria-pressed={selected} onClick={onClick}>
      {inner}
    </button>
  );
}

const imageOf = (message: Message | undefined) => message?.attachments.find(a => a.content_type?.startsWith("image/"));

/** One post of the forum page: title, tags, a plain-text preview of the first message, author, replies and last activity. */
export function ForumPostCard({ thread, first, forum, layout, selected, onOpen }: { thread: Channel; first: Message | undefined; forum: Channel; layout: "list" | "gallery"; selected: boolean; onOpen(thread: Channel): void }) {
  const owner = useStore(s => (thread.owner_id ? s.users[thread.owner_id] : undefined));
  const member = useStore(s => (thread.guild_id && thread.owner_id ? s.members[thread.guild_id]?.[thread.owner_id] : undefined));
  const author = owner ?? first?.author;
  const tags = (thread.applied_tags ?? []).flatMap(id => forum.available_tags?.find(t => t.id === id) ?? []);
  const archived = thread.thread_metadata?.archived === true;
  const image = layout === "gallery" ? imageOf(first) : undefined;
  const replies = thread.message_count ?? 0;
  const text = first ? previewText(first.content || (first.attachments.length > 0 ? "Sent an attachment" : ""), layout === "gallery" ? 120 : 240) : "";
  return (
    <button type="button" className={`forum-post ${layout}${selected ? " selected" : ""}${archived ? " archived" : ""}`} aria-label={`Open post ${thread.name ?? ""}`} onClick={() => onOpen(thread)}>
      {layout === "gallery" && (
        <span className="forum-post-media">
          {image ? <img src={resolveUrl(image.url)} alt={image.description ?? ""} draggable={false} /> : <span className="forum-post-media-text">{text}</span>}
        </span>
      )}
      <span className="forum-post-body">
        <span className="forum-post-title">
          {isPinned(thread) && <Pin size={14} aria-label="Pinned" />}
          {thread.thread_metadata?.locked && <Lock size={14} aria-label="Locked" />}
          {archived && <Archive size={14} aria-label="Archived" />}
          <span className="forum-post-name">{thread.name}</span>
        </span>
        {tags.length > 0 && (
          <span className="forum-post-tags">
            {tags.map(tag => (
              <TagChip key={tag.id} tag={tag} />
            ))}
          </span>
        )}
        {layout === "list" && text && <span className="forum-post-preview">{text}</span>}
        <span className="forum-post-footer">
          {author && <Avatar user={author} size={20} />}
          <span className="forum-post-author">{author ? displayName(author, member) : "Unknown user"}</span>
          <span className="forum-post-meta">
            <MessageSquareText size={14} aria-hidden="true" /> {replies}
          </span>
          <span className="forum-post-meta">{timeAgo(lastActivityMs(thread))}</span>
        </span>
      </span>
    </button>
  );
}
