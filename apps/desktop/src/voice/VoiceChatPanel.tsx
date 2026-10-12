import { MessageCircle, X } from "lucide-react";
import { ChatView } from "../chat/ChatView";
import type { Channel } from "../api/types";
import { BottomSheet, usePhone } from "../ui";
import { useVoiceUi } from "./uiStore";

/** Text-in-voice side panel: the same chat as a text channel (message list + composer), under a small header. */
export function VoiceChatPanel({ channel }: { channel: Channel }) {
  const name = channel.name ?? "this channel";
  const phone = usePhone();
  // A phone has no room for a side panel: the same chat is a full-height sheet over the call.
  if (phone) {
    return (
      <BottomSheet open onClose={() => useVoiceUi.getState().setChatOpen(false)} label={`${name} chat`} className="voice-chat-sheet">
        <h2 className="sheet-title">Chat</h2>
        <ChatView key={channel.id} channelId={channel.id} />
      </BottomSheet>
    );
  }
  return (
    <aside className="voice-chat" aria-label={`${name} chat`}>
      <header className="voice-chat-header">
        <MessageCircle size={20} aria-hidden="true" />
        <h2 className="voice-chat-title">{name}</h2>
        <button type="button" className="voice-chat-close" aria-label="Close Chat" onClick={() => useVoiceUi.getState().setChatOpen(false)}>
          <X size={20} />
        </button>
      </header>
      <ChatView key={channel.id} channelId={channel.id} />
    </aside>
  );
}
