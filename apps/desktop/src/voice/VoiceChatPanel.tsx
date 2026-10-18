import { MessageCircle, X } from "lucide-react";
import { ChatView } from "../chat/ChatView";
import { channelMentionCount, isChannelUnread, useStore } from "../api/store";
import type { Channel, Snowflake } from "../api/types";
import { useVoiceUi } from "./uiStore";

/** Unread cue for the header's Show Chat button while the voice channel's chat is closed: a red count for mentions, else a dot. */
export function VoiceChatBadge({ channelId }: { channelId: Snowflake }) {
  const chatOpen = useVoiceUi(s => s.chatOpen);
  const unread = useStore(s => isChannelUnread(s, channelId));
  const mentions = useStore(s => channelMentionCount(s, channelId));
  if (chatOpen || (!unread && mentions === 0)) return null;
  return mentions > 0 ? (
    <span className="count-badge voice-chat-badge" role="img" aria-label={`${mentions} unread mention${mentions === 1 ? "" : "s"}`}>
      {mentions}
    </span>
  ) : (
    <span className="voice-chat-badge dot" role="img" aria-label="Unread messages" />
  );
}

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
