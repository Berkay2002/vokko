import { MessageSquareText } from "lucide-react";
import { useStore } from "../api/store";
import type { Channel } from "../api/types";
import { go, guildPath } from "../shell/nav";
import { lastActivityMs } from "./util";
import { openThread, useThreadUi } from "./threadUi";
import "./threads.css";

const MAX_ROWS = 8;

/** Active threads the viewer joined, listed under their channel in the sidebar (Discord shows the same). Click opens the thread beside its channel. */
export function ChannelThreads({ channel }: { channel: Channel }) {
  const joined = useStore(s => Object.values(s.threads).filter(t => t.parent_id === channel.id && t.member && !t.thread_metadata?.archived));
  const openId = useThreadUi(s => s.openId);
  if (joined.length === 0 || !channel.guild_id) return null;
  const guildId = channel.guild_id;
  const rows = [...joined].sort((a, b) => lastActivityMs(b) - lastActivityMs(a)).slice(0, MAX_ROWS);
  return (
    <ul className="thread-rows" aria-label={`Threads in ${channel.name ?? "channel"}`}>
      {rows.map(thread => (
        <li key={thread.id}>
          <button
            type="button"
            className={`thread-row-link${openId === thread.id ? " selected" : ""}`}
            onClick={() => {
              go(guildPath(guildId, channel.id));
              openThread(thread);
            }}
          >
            <MessageSquareText size={16} aria-hidden="true" />
            <span>{thread.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
