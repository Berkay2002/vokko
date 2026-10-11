// The type 3 call message in a DM: "X started a call." while it goes on, then "... that lasted N minutes" or, for someone who
// never joined, "You missed a call from X ...".

import { Phone, PhoneMissed } from "lucide-react";
import { useStore } from "../api/store";
import type { Message } from "../api/types";
import { useVoice } from "../voice/store";
import { startCall } from "./engine";
import { callDuration, useCalls } from "./store";

export function callNoticeKind(message: Message, meId: string | null): "ongoing" | "ended" | "missed" {
  const call = message.call ?? { participants: [message.author.id], ended_timestamp: null };
  if (!call.ended_timestamp) return "ongoing";
  return meId && !call.participants.includes(meId) ? "missed" : "ended";
}

export function CallNotice({ message, name }: { message: Message; name: string }) {
  const meId = useStore(s => s.me?.id ?? null);
  const channel = useStore(s => s.channels[message.channel_id]);
  const live = useCalls(s => s.calls[message.channel_id]?.messageId === message.id);
  const here = useVoice(s => s.channelId === message.channel_id);
  const kind = callNoticeKind(message, meId);
  const ended = message.call?.ended_timestamp;
  const lasted = ended ? callDuration(message.timestamp, ended) : "";
  return (
    <>
      {kind === "missed" ? (
        <PhoneMissed size={18} className="chat-system-icon call-missed" aria-hidden="true" />
      ) : (
        <Phone size={18} className="chat-system-icon join" aria-hidden="true" />
      )}
      <span className="chat-system-text" data-call={kind}>
        {kind === "missed" ? (
          <>
            You missed a call from <b>{name}</b> that lasted {lasted}.
          </>
        ) : kind === "ended" ? (
          <>
            <b>{name}</b> started a call that lasted {lasted}.
          </>
        ) : (
          <>
            <b>{name}</b> started a call.
            {live && !here && channel && (
              <>
                {" "}
                <button type="button" className="chat-system-link" onClick={() => startCall(channel)}>
                  Join the call
                </button>
              </>
            )}
          </>
        )}
      </span>
    </>
  );
}
