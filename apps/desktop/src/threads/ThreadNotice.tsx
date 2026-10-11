import { MessageSquareText } from "lucide-react";
import type { Message } from "../api/types";
import { openThreadById, openThreadList } from "./threadUi";

/** Body of a type 18 system message: "<name> started a thread: <thread name>." (content = thread name, the reference's channel is the thread). */
export function ThreadCreatedNotice({ message, name }: { message: Message; name: string }) {
  const threadId = message.message_reference?.channel_id;
  return (
    <>
      <MessageSquareText size={18} className="chat-system-icon" aria-hidden="true" />
      <span className="chat-system-text">
        <b>{name}</b> started a thread:{" "}
        <button type="button" className="chat-system-link" onClick={() => threadId && void openThreadById(threadId, message.channel_id, message.content)}>
          {message.content}
        </button>
        . See all{" "}
        <button type="button" className="chat-system-link" onClick={openThreadList}>
          threads
        </button>
        .
      </span>
    </>
  );
}
