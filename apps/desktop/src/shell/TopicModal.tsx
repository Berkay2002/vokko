import { useMemo, useState } from "react";
import { useStore } from "../api/store";
import type { Snowflake } from "../api/types";
import { ChatProvider, useChat, type ChatActions } from "../chat/ChatContext";
import { LinkModal } from "../chat/ChatView";
import { Markdown } from "../chat/markdown";
import { Modal } from "../ui";
import { closeModal } from "./modalStore";
import "../chat/chat.css";

function Topic({ topic }: { topic: string }) {
  const chat = useChat();
  return <Markdown content={topic} ctx={chat.md} className="chat-content topic-modal-text" />;
}

/** The full channel topic (the header cuts it to one line), rendered by the chat Markdown renderer like a message. */
export function TopicModal({ channelId }: { channelId: Snowflake }) {
  const channel = useStore(s => s.channels[channelId]);
  const [link, setLink] = useState<string | null>(null);
  // Links ask first ("Leaving Vokko"), like in the chat.
  const actions = useMemo<ChatActions>(
    () => ({ reply() {}, edit() {}, requestDelete() {}, togglePin() {}, react() {}, openImage() {}, viewAttachment() {}, deleteAttachment() {}, viewReactions() {}, jumpTo() {}, openLink: setLink }),
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
