import { ChevronRight, MessageSquareText } from "lucide-react";
import { useStore } from "../api/store";
import type { Message } from "../api/types";
import { lastActivityMs, messageCountLabel, timeAgo } from "./util";
import { openThread } from "./threadUi";
import "./threads.css";

/** The line under a message that started a thread: name, message count and last activity. Click opens the thread in the side panel. */
export function ThreadChip({ message }: { message: Message }) {
  const started = message.thread;
  // The store has the live copy (counts and name change after the message was loaded).
  const live = useStore(s => (started ? s.threads[started.id] : undefined));
  if (!started) return null;
  const thread = live ?? started;
  const archived = thread.thread_metadata?.archived === true;
  return (
    <button type="button" className={`thread-chip${archived ? " archived" : ""}`} aria-label={`Open thread ${thread.name ?? ""}`} onClick={() => openThread(thread)}>
      <MessageSquareText size={16} className="thread-chip-icon" aria-hidden="true" />
      <span className="thread-chip-name">{thread.name}</span>
      <span className="thread-chip-meta">
        {messageCountLabel(thread.message_count)} · {timeAgo(lastActivityMs(thread))}
      </span>
      <ChevronRight size={16} className="thread-chip-chevron" aria-hidden="true" />
    </button>
  );
}
