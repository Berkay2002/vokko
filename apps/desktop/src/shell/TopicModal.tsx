import { useMemo, useState } from "react";
import { useStore } from "../api/store";
import type { Snowflake } from "../api/types";
import { ChatProvider, useChat, type ChatActions } from "../chat/ChatContext";
import { LinkModal } from "../chat/ChatView";
import { InlineMarkdown, Markdown } from "../chat/markdown";
import { Modal } from "../ui";
import { closeModal, openModal } from "./modalStore";
import "../chat/chat.css";

function Topic({ topic }: { topic: string }) {
  const chat = useChat();
  return <Markdown content={topic} ctx={chat.md} className="chat-content topic-modal-text" />;
}

// A chat context for a surface that is not the chat: every message action is a no-op, links ask first ("Leaving Vokko").
const topicActions = (openLink: (href: string) => void): ChatActions => ({ reply() {}, edit() {}, requestDelete() {}, togglePin() {}, react() {}, openImage() { return false; }, viewAttachment() {}, deleteAttachment() {}, viewReactions() {}, jumpTo() {}, openLink });

function InlineTopic({ topic }: { topic: string }) {
  const chat = useChat();
  return <InlineMarkdown content={topic} ctx={chat.md} />;
}

/**
 * The topic in the channel header: one line of inline Markdown. The button that opens the full topic lies under the text (the
 * text takes no pointer events, only its links and chips do), so a link inside it is not nested in the button.
 */
export function TopicLine({ channelId, topic }: { channelId: Snowflake; topic: string }) {
  const [link, setLink] = useState<string | null>(null);
  const actions = useMemo(() => topicActions(setLink), []);
  const open = `channel-topic-${channelId}`;
  const text = `${open}-text`;
  return (
    <>
      <div className="channel-header-topic">
        <button type="button" id={open} className="channel-header-topic-open" title={topic} aria-haspopup="dialog" aria-label="Channel topic:" aria-labelledby={`${open} ${text}`} onClick={() => openModal({ type: "channelTopic", channelId })} />
        <span id={text} className="channel-header-topic-text">
          <ChatProvider channelId={channelId} actions={actions}>
            <InlineTopic topic={topic} />
          </ChatProvider>
        </span>
      </div>
      <LinkModal href={link} onClose={() => setLink(null)} />
    </>
  );
}

/** The full channel topic (the header cuts it to one line), rendered by the chat Markdown renderer like a message. */
export function TopicModal({ channelId }: { channelId: Snowflake }) {
  const channel = useStore(s => s.channels[channelId]);
  const [link, setLink] = useState<string | null>(null);
  // Links ask first ("Leaving Vokko"), like in the chat.
  const actions = useMemo<ChatActions>(
    () => topicActions(setLink),
    [],
  );
  if (!channel?.topic) return null;
  return (
    <>
      <Modal
        open
        onClose={closeModal}
        title={`#${channel.name}`}
        footer={<button type="button" className="btn btn-primary" onClick={closeModal}>Done</button>}
      >
        <ChatProvider channelId={channelId} actions={actions}>
          <Topic topic={channel.topic} />
        </ChatProvider>
      </Modal>
      <LinkModal href={link} onClose={() => setLink(null)} />
    </>
  );
}
