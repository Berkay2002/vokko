import { ChartBarBig, Trophy } from "lucide-react";
import type { Message } from "../api/types";
import { useChat } from "../chat/ChatContext";
import { percentOf, resultSummary } from "./pollState";
import "./polls.css";

/** Body of a type 46 system message: "<name>'s poll <question> has closed", the winner (or none) and a jump back to the poll. */
export function PollResultNotice({ message, name }: { message: Message; name: string }) {
  const chat = useChat();
  const summary = resultSummary(message.embeds);
  const pollId = message.message_reference?.message_id;
  const winner = summary?.winner;
  return (
    <>
      <ChartBarBig size={18} className="chat-system-icon" aria-hidden="true" />
      <span className="chat-system-text poll-result">
        <b>{name}</b>&apos;s poll <b>{summary?.question ?? ""}</b> has closed.{" "}
        {winner ? (
          <span className="poll-result-winner">
            <Trophy size={14} aria-hidden="true" /> {winner.emoji && !winner.emoji.id ? `${winner.emoji.name} ` : ""}
            <b>{winner.text}</b> won with {percentOf(winner.votes, summary.total)}% ({winner.votes} {winner.votes === 1 ? "vote" : "votes"}).
          </span>
        ) : (
          <span className="poll-result-winner">{summary && summary.total > 0 ? "It ended in a tie." : "Nobody voted."}</span>
        )}{" "}
        {pollId && (
          <button type="button" className="chat-system-link" onClick={() => chat.actions.jumpTo(pollId)}>
            View Poll
          </button>
        )}
      </span>
    </>
  );
}
