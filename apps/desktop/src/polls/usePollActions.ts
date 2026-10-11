// What the message menu offers for a poll: End Poll Now for its author while it is still open.
import type { Message } from "../api/types";
import { endPoll } from "./api";
import { isEnded } from "./pollState";
import { chatToast } from "../chat/toast";

export function canEndPoll(message: Message, myId: string, now = Date.now()): boolean {
  return !!message.poll && message.author.id === myId && !isEnded(message.poll, now);
}

/** Ends the poll; the final results and the result message arrive over the gateway. */
export function endPollNow(message: Message): void {
  endPoll(message.channel_id, message.id).catch((error: unknown) => chatToast(error instanceof Error ? error.message : "Could not end the poll."));
}
