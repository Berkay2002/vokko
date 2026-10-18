import { BellOff, MessageSquareText } from "lucide-react";
import { useStore } from "../api/store";
import type { Channel } from "../api/types";
import { useContextMenu } from "../ui";
import { threadBellItems, useThreadMuted } from "./mute";
import { isThreadUnread, lastActivityMs } from "./util";
import { goToThread, useThreadUi } from "./threadUi";
import "./threads.css";

const MAX_ROWS = 8;

/** One joined thread under its channel: strong name and a mention badge while unread, dimmed with a bell-off icon while muted (the channel row's rules). */
function ThreadLink({ thread }: { thread: Channel }) {
  const selected = useThreadUi(s => s.openId === thread.id);
  const muted = useThreadMuted(thread);
  const unread = useStore(s => isThreadUnread(thread, s.readStates[thread.id])) && !muted;
  const mentions = useStore(s => s.readStates[thread.id]?.mention_count ?? 0);
  const menu = useContextMenu();
  return (
    <button
      type="button"
      className={`thread-row-link${selected ? " selected" : ""}${unread ? " unread" : ""}${muted ? " muted" : ""}`}
      onClick={() => goToThread(thread)}
      onContextMenu={e => menu.open(e, threadBellItems(thread))}
    >
      <MessageSquareText size={16} aria-hidden="true" />
      <span>{thread.name}</span>
      {muted && <BellOff size={14} aria-label="Muted" />}
      {mentions > 0 && !muted ? <span className="count-badge">{mentions}</span> : null}
    </button>
  );
}

/** Active threads the viewer joined, listed under their channel in the sidebar (Discord shows the same). Click opens the thread beside its channel. */
export function ChannelThreads({ channel }: { channel: Channel }) {
  const joined = useStore(s => Object.values(s.threads).filter(t => t.parent_id === channel.id && t.member && !t.thread_metadata?.archived));
  if (joined.length === 0 || !channel.guild_id) return null;
  const rows = [...joined].sort((a, b) => lastActivityMs(b) - lastActivityMs(a)).slice(0, MAX_ROWS);
  return (
    <ul className="thread-rows" aria-label={`Threads in ${channel.name ?? "channel"}`}>
      {rows.map(thread => (
        <li key={thread.id}>
          <ThreadLink thread={thread} />
        </li>
      ))}
    </ul>
  );
}
