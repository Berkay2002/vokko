import { MessageCircle, X } from "lucide-react";
import { ChatView } from "../chat/ChatView";
import type { Channel } from "../api/types";
import { useVoiceUi } from "./uiStore";

/** Text-in-voice side panel: the same chat as a text channel (message list + composer), under a small header. On a phone it covers the call (voice.css). */
export function VoiceChatPanel({ channel }: { channel: Channel }) {
  const name = channel.name ?? "this channel";
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
