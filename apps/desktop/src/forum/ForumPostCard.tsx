import { useEffect, useRef, useState } from "react";
import { Archive, Lock, MessageSquareText, Pin, SmilePlus } from "lucide-react";
import { request, resolveUrl } from "../api/rest";
import { displayName, useStore } from "../api/store";
import type { Channel, ForumTag, Message, Reaction, ReactionEmoji } from "../api/types";
import { chatToast } from "../chat/toast";
import { Avatar } from "../shell/Avatar";
import { isPinned, isThreadUnread, lastActivityMs, previewText, timeAgo, topReaction } from "../threads/util";
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

/**
 * Reaction button of a card: the starter message's most used reaction, else the forum's default reaction with no count. Toggles the
 * viewer's own reaction on the starter message; the list refetches on the gateway echo.
 */
function CardReaction({ thread, first, forum }: { thread: Channel; first: Message; forum: Channel }) {
  const top = topReaction(first.reactions);
  const fallback = forum.default_reaction_emoji?.emoji_name ? { emoji: { id: forum.default_reaction_emoji.emoji_id, name: forum.default_reaction_emoji.emoji_name }, count: 0, count_details: { normal: 0, burst: 0 }, burst_colors: [], me: false, me_burst: false } : undefined;
  const shown: Reaction | undefined = top ?? fallback;
  const [local, setLocal] = useState<Reaction | undefined>(shown);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const key = shown ? `${shown.emoji.id ?? shown.emoji.name}:${shown.count}:${shown.me}` : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setLocal(shown), [key]);
  if (!local) return null;
  const emoji: ReactionEmoji = local.emoji;
  // One request at a time: clicks while one is in flight are ignored; a failure rolls back to the state before the click.
  const toggle = () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    const before = local;
    const had = before.me;
    setLocal({ ...before, me: !had, count: Math.max(0, before.count + (had ? -1 : 1)) });
    const name = emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
    request<null>(had ? "DELETE" : "PUT", `/channels/${thread.id}/messages/${first.id}/reactions/${encodeURIComponent(name)}/@me`)
      .catch(() => {
        setLocal(before);
        chatToast(had ? "Could not remove the reaction." : "Could not add the reaction.");
      })
      .finally(() => {
        busy.current = false;
        setPending(false);
      });
  };
  // shortcut: custom emoji show as :name: text (no emoji image URL helper on the client yet), upgrade with the chat reactions.
  const glyph = emoji.id ? `:${emoji.name}:` : emoji.name;
  return (
    <button type="button" className={`forum-post-reaction${local.me ? " me" : ""}`} aria-pressed={local.me} aria-disabled={pending || undefined} aria-label={local.count > 0 ? `${local.count} ${emoji.name}` : `React with ${emoji.name}`} onClick={toggle}>
      {local.count > 0 ? <span aria-hidden="true">{glyph}</span> : <SmilePlus size={14} aria-hidden="true" />}
      {local.count > 0 ? <span>{local.count}</span> : <span aria-hidden="true">{glyph}</span>}
    </button>
  );
}

const imageOf = (message: Message | undefined) => message?.attachments.find(a => a.content_type?.startsWith("image/"));

/**
 * One post of the forum page: title, tags, a plain-text preview of the first message, author, replies, last activity and a reaction.
 * The whole card opens the post (a button stretched over it); the reaction button sits above that layer.
 */
export function ForumPostCard({ thread, first, forum, layout, selected, onOpen }: { thread: Channel; first: Message | undefined; forum: Channel; layout: "list" | "gallery"; selected: boolean; onOpen(thread: Channel): void }) {
  const owner = useStore(s => (thread.owner_id ? s.users[thread.owner_id] : undefined));
  const member = useStore(s => (thread.guild_id && thread.owner_id ? s.members[thread.guild_id]?.[thread.owner_id] : undefined));
  const author = owner ?? first?.author;
  const tags = (thread.applied_tags ?? []).flatMap(id => forum.available_tags?.find(t => t.id === id) ?? []);
  const archived = thread.thread_metadata?.archived === true;
  const image = layout === "gallery" ? imageOf(first) : undefined;
  const replies = thread.message_count ?? 0;
  const unread = useStore(s => isThreadUnread(thread, s.readStates[thread.id]));
  const text = first ? previewText(first.content || (first.attachments.length > 0 ? "Sent an attachment" : ""), layout === "gallery" ? 120 : 240) : "";
  return (
    <article className={`forum-post ${layout}${selected ? " selected" : ""}${archived ? " archived" : ""}${unread ? " unread" : ""}`} aria-label={thread.name ?? undefined}>
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
          {first && <CardReaction thread={thread} first={first} forum={forum} />}
        </span>
      </span>
      <button type="button" className="forum-post-open" aria-label={`Open post ${thread.name ?? ""}${unread ? " (unread)" : ""}`} onClick={() => onOpen(thread)} />
    </article>
  );
}
