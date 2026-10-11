import { useEffect, useRef, useState } from "react";
import { Check, CircleCheck } from "lucide-react";
import type { Message, PollAnswer, User } from "../api/types";
import { ApiRequestError, Popout } from "../chat/shell";
import { useChat } from "../chat/ChatContext";
import { Avatar } from "../chat/Avatar";
import * as api from "./api";
import { countOf, isEnded, leaders, myVotes, percentOf, timeLeft, totalVotes } from "./pollState";
import "./polls.css";

/** Re-renders every 30 s so "time left" and the ended state follow the clock. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "Something went wrong. Try again.";
}

function AnswerLabel({ answer }: { answer: PollAnswer }) {
  const emoji = answer.poll_media.emoji;
  return (
    <span className="poll-answer-label">
      {emoji && <span className="poll-answer-emoji" aria-hidden="true">{emoji.id ? `:${emoji.name}:` : emoji.name}</span>}
      <span className="poll-answer-text">{answer.poll_media.text}</span>
    </span>
  );
}

/** "N votes" on an answer in results mode; opens the list of voters. */
function VoteCount({ message, answer, count }: { message: Message; answer: PollAnswer; count: number }) {
  const chat = useChat();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setUsers(null);
    setError(null);
    api.voters(message.channel_id, message.id, answer.answer_id).then(
      list => live && setUsers(list),
      e => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [open, message.channel_id, message.id, answer.answer_id, count]);

  return (
    <>
      <button ref={button} type="button" className="poll-count" disabled={count === 0} aria-label={`${count} votes for ${answer.poll_media.text ?? ""}, show voters`} onClick={() => setOpen(v => !v)}>
        {count} {count === 1 ? "vote" : "votes"}
      </button>
      <Popout anchor={button} open={open} onClose={() => setOpen(false)} side="top">
        <div className="poll-voters" role="dialog" aria-label={`Voters for ${answer.poll_media.text ?? ""}`}>
          <div className="poll-voters-title">
            <AnswerLabel answer={answer} />
          </div>
          {error && <p className="poll-error">{error}</p>}
          {!error && users === null && <p className="poll-voters-empty">Loading…</p>}
          {users?.length === 0 && <p className="poll-voters-empty">No votes yet.</p>}
          {users && users.length > 0 && (
            <ul className="poll-voters-list">
              {users.map(user => (
                <li key={user.id}>
                  <Avatar user={user} size={24} guildId={chat.guildId} />
                  <span>{chat.nameOf(user)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Popout>
    </>
  );
}

/** A poll inside a message: pick answers and vote, or see the results (bars, percentages, your vote checked, voters). */
export function PollView({ message }: { message: Message }) {
  const poll = message.poll;
  const now = useNow();
  const [selected, setSelected] = useState<number[]>([]);
  const [peek, setPeek] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!poll) return null;

  const ended = isEnded(poll, now);
  const mine = myVotes(poll);
  const voted = mine.length > 0;
  const results = ended || voted || peek;
  const total = totalVotes(poll);
  const winners = ended ? leaders(poll) : [];

  function toggle(answerId: number) {
    if (!poll || busy) return;
    setError(null);
    setSelected(current => (poll.allow_multiselect ? (current.includes(answerId) ? current.filter(id => id !== answerId) : [...current, answerId]) : [answerId]));
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setSelected([]);
      setPeek(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const submit = () => run(() => Promise.all(selected.map(id => api.vote(message.channel_id, message.id, id))));
  const remove = () => run(() => Promise.all(mine.map(id => api.unvote(message.channel_id, message.id, id))));

  return (
    <section className={`poll${ended ? " ended" : ""}`} aria-label={`Poll: ${poll.question.text ?? ""}`}>
      <h4 className="poll-question">{poll.question.text}</h4>
      <div className="poll-hint">{ended ? "Final results" : poll.allow_multiselect ? "Select one or more answers" : "Select one answer"}</div>
      <div className="poll-answers" role={results ? "list" : poll.allow_multiselect ? "group" : "radiogroup"}>
        {poll.answers.map(answer => {
          const count = countOf(poll, answer.answer_id);
          const pct = percentOf(count, total);
          const isMine = mine.includes(answer.answer_id);
          if (results) {
            return (
              <div key={answer.answer_id} role="listitem" className={`poll-answer result${isMine ? " mine" : ""}${winners.includes(answer.answer_id) ? " winner" : ""}`}>
                <div className="poll-bar" style={{ width: `${pct}%` }} aria-hidden="true" />
                <AnswerLabel answer={answer} />
                {isMine && <CircleCheck size={18} className="poll-mine-icon" aria-label="Your vote" />}
                <VoteCount message={message} answer={answer} count={count} />
                <span className="poll-percent">{pct}%</span>
              </div>
            );
          }
          const checked = selected.includes(answer.answer_id);
          return (
            <button
              key={answer.answer_id}
              type="button"
              role={poll.allow_multiselect ? "checkbox" : "radio"}
              aria-checked={checked}
              className={`poll-answer choice${checked ? " selected" : ""}`}
              onClick={() => toggle(answer.answer_id)}
            >
              <AnswerLabel answer={answer} />
              <span className={`poll-check${poll.allow_multiselect ? " square" : ""}`} aria-hidden="true">
                {checked && <Check size={14} />}
              </span>
            </button>
          );
        })}
      </div>
      {error && (
        <p className="poll-error" role="alert">
          {error}
        </p>
      )}
      <div className="poll-footer">
        <span className="poll-meta">
          {total} {total === 1 ? "vote" : "votes"} • {ended ? "Poll closed" : timeLeft(poll.expiry, now)}
        </span>
        <span className="poll-actions">
          {!results && (
            <button type="button" className="poll-link" onClick={() => setPeek(true)}>
              Show results
            </button>
          )}
          {peek && !voted && !ended && (
            <button type="button" className="poll-link" onClick={() => setPeek(false)}>
              Go back to vote
            </button>
          )}
          {voted && !ended && (
            <button type="button" className="poll-link" disabled={busy} onClick={() => void remove()}>
              Remove Vote
            </button>
          )}
          {!results && (
            <button type="button" className="btn btn-primary poll-vote" disabled={busy || selected.length === 0} onClick={() => void submit()}>
              Vote
            </button>
          )}
        </span>
      </div>
    </section>
  );
}
