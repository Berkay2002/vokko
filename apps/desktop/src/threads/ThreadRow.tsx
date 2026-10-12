import { useEffect, useState } from "react";
import { BellOff, MessageSquareText, Pin, Lock } from "lucide-react";
import { request } from "../api/rest";
import { displayName, useStore } from "../api/store";
import type { Channel, Message } from "../api/types";
import { MessageType } from "../api/types";
import { useContextMenu } from "../ui";
import { threadBellItems, useThreadMuted } from "./mute";
import { isPinned, lastActivityMs, messageCountLabel, previewText, timeAgo } from "./util";

const previews = new Map<string, Message | null>();

/** The latest message of a thread (one cached request per thread and last_message_id), for the "last message" line of a row. */
function useLastMessage(thread: Channel): Message | null | undefined {
  const key = `${thread.id}:${thread.last_message_id ?? ""}`;
  const [message, setMessage] = useState<Message | null | undefined>(() => (previews.has(key) ? previews.get(key) : undefined));
  useEffect(() => {
    if (!thread.last_message_id) {
      setMessage(null);
      return;
    }
    if (previews.has(key)) {
      setMessage(previews.get(key));
      return;
    }
    let live = true;
    request<Message[]>("GET", `/channels/${thread.id}/messages?limit=1`)
      .then(list => {
        previews.set(key, list[0] ?? null);
        if (live) setMessage(list[0] ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [key, thread.id, thread.last_message_id]);
  return message;
}

/** One row of the threads popout: name, last message ("Author: text"), message count and last activity. */
export function ThreadRow({ thread, onOpen }: { thread: Channel; onOpen(thread: Channel): void }) {
  const last = useLastMessage(thread);
  const guildId = thread.guild_id;
  const members = useStore(s => (guildId ? s.members[guildId] : undefined));
  const author = last ? displayName(last.author, members?.[last.author.id]) : null;
  const text = last ? previewText(last.type === MessageType.ThreadStarterMessage ? (last.referenced_message?.content ?? "") : last.content || (last.attachments.length > 0 ? "Sent an attachment" : "")) : "";
  const archived = thread.thread_metadata?.archived === true;
  const muted = useThreadMuted(thread);
  const menu = useContextMenu();
  return (
    <button type="button" className={`thread-row${archived ? " archived" : ""}${muted ? " muted" : ""}`} onClick={() => onOpen(thread)} onContextMenu={e => menu.open(e, threadBellItems(thread))}>
      <span className="thread-row-icon" aria-hidden="true">
        <MessageSquareText size={20} />
      </span>
      <span className="thread-row-main">
        <span className="thread-row-title">
          {isPinned(thread) && <Pin size={13} aria-label="Pinned" />}
          {thread.thread_metadata?.locked && <Lock size={13} aria-label="Locked" />}
          {muted && <BellOff size={13} aria-label="Muted" />}
          <span className="thread-row-name">{thread.name}</span>
        </span>
        <span className="thread-row-preview">{author && text ? `${author}: ${text}` : last === undefined ? "" : "No messages yet"}</span>
      </span>
      <span className="thread-row-meta">
        <span>{messageCountLabel(thread.message_count)}</span>
        <span>{timeAgo(lastActivityMs(thread))}</span>
      </span>
    </button>
  );
}
