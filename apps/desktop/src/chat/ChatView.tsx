// Placeholder: vokko-chat owns the real implementation of this module and replaces this file.
import { useStore } from "../api/store";

export function ChatView({ channelId }: { channelId: string }) {
  const channel = useStore(s => s.channels[channelId]);
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)" }}>
      Messages for {channel?.name ?? channelId} go here (vokko-chat).
    </div>
  );
}
