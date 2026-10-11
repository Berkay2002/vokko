import { CircleAlert } from "lucide-react";
import type { Message } from "../api/types";
import { Attachments } from "../chat/Attachments";
import { Avatar } from "../chat/Avatar";
import { useChat } from "../chat/ChatContext";
import { Embeds } from "../chat/Embeds";
import { Markdown } from "../chat/markdown";
import { formatMessageTimestamp } from "../chat/util";
import { Tooltip } from "../ui";
import "./threads.css";

/**
 * First message of a thread started from a message (type 21): shown as the original message it points at (`referenced_message`),
 * not as a reply. Text goes through the markdown renderer like any message, never as HTML.
 */
export function ThreadStarter({ message }: { message: Message }) {
  const chat = useChat();
  const original = message.referenced_message;
  if (!original) {
    return (
      <div className="chat-msg system thread-starter missing" id={`message-${message.id}`} data-message-id={message.id}>
        <div className="chat-msg-gutter">
          <span />
        </div>
        <div className="chat-msg-body system">
          <CircleAlert size={18} className="chat-system-icon" aria-hidden="true" />
          <span className="chat-system-text">The message this thread started from was deleted.</span>
        </div>
      </div>
    );
  }
  const color = chat.colorOf(original);
  const date = new Date(original.timestamp);
  return (
    <div className="chat-msg thread-starter" id={`message-${message.id}`} data-message-id={message.id} aria-label="Thread starter message">
      <div className="chat-msg-gutter">
        <Avatar user={original.author} size={40} />
      </div>
      <div className="chat-msg-body">
        <h3 className="chat-msg-header">
          <span className="chat-author" style={color ? { color } : undefined}>
            {chat.nameOf(original.author, original.member)}
          </span>
          <Tooltip content={date.toLocaleString()}>
            <time className="chat-timestamp" dateTime={original.timestamp}>
              {formatMessageTimestamp(date)}
            </time>
          </Tooltip>
        </h3>
        {original.content && <Markdown content={original.content} ctx={chat.md} className="chat-content" />}
        <Attachments message={original} />
        <Embeds message={original} />
      </div>
    </div>
  );
}
