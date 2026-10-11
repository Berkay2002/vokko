// Pure poll logic: applying vote events, percentages, time left, the create-poll draft and the result message's summary.
import { POLL_ANSWER_MAX, POLL_DURATIONS_HOURS, POLL_MAX_ANSWERS, POLL_QUESTION_MAX, type Embed, type Message, type Poll, type PollCreateRequest, type ReactionEmoji } from "../api/types";

/** MESSAGE_POLL_VOTE_ADD / _REMOVE applied to a message (unchanged when it has no poll or no such answer). */
export function applyPollVote(message: Message, answerId: number, add: boolean, byMe: boolean): Message {
  const poll = message.poll;
  if (!poll) return message;
  const index = poll.results.answer_counts.findIndex(count => count.id === answerId);
  if (index < 0) return message;
  // Our own echo for a vote we already show (or a removal we already show) changes nothing.
  if (byMe && poll.results.answer_counts[index]?.me_voted === add) return message;
  const answer_counts = poll.results.answer_counts.map((count, i) => {
    if (i !== index) return count;
    return { ...count, count: Math.max(0, count.count + (add ? 1 : -1)), me_voted: byMe ? add : count.me_voted };
  });
  return { ...message, poll: { ...poll, results: { ...poll.results, answer_counts } } };
}

export function totalVotes(poll: Poll): number {
  return poll.results.answer_counts.reduce((sum, count) => sum + count.count, 0);
}

export function countOf(poll: Poll, answerId: number): number {
  return poll.results.answer_counts.find(count => count.id === answerId)?.count ?? 0;
}

export function myVotes(poll: Poll): number[] {
  return poll.results.answer_counts.filter(count => count.me_voted).map(count => count.id);
}

/** Whole percent of all votes (0 when nobody voted). */
export function percentOf(count: number, total: number): number {
  return total > 0 ? Math.round((count * 100) / total) : 0;
}

export function isEnded(poll: Poll, now: number): boolean {
  return poll.results.is_finalized || Date.parse(poll.expiry) <= now;
}

/** Answer ids with the most votes; empty when nobody voted. */
export function leaders(poll: Poll): number[] {
  const top = Math.max(0, ...poll.results.answer_counts.map(count => count.count));
  return top === 0 ? [] : poll.results.answer_counts.filter(count => count.count === top).map(count => count.id);
}

/** "3d left", "5h left", "12m left", "Less than a minute left" (nearest unit, so a fresh 3 day poll reads "3d left"). */
export function timeLeft(expiry: string, now: number): string {
  const ms = Date.parse(expiry) - now;
  if (!(ms > 0)) return "Poll closed";
  if (ms < 60_000) return "Less than a minute left";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h left`;
  return `${Math.round(hours / 24)}d left`;
}

export const DURATION_LABELS: Record<(typeof POLL_DURATIONS_HOURS)[number], string> = { 1: "1 hour", 4: "4 hours", 8: "8 hours", 24: "24 hours", 72: "3 days", 168: "1 week", 336: "2 weeks" };

export interface PollDraft {
  question: string;
  answers: { text: string; emoji: ReactionEmoji | null }[];
  duration: number;
  multiselect: boolean;
}

export const emptyDraft = (): PollDraft => ({ question: "", answers: [{ text: "", emoji: null }, { text: "", emoji: null }], duration: 24, multiselect: false });

/** The request for a draft, or why it cannot be posted yet. Blank answers are dropped. */
export function draftToRequest(draft: PollDraft): { request: PollCreateRequest } | { error: string } {
  const question = draft.question.trim();
  if (question === "") return { error: "Add a question." };
  if (question.length > POLL_QUESTION_MAX) return { error: `The question can be at most ${POLL_QUESTION_MAX} characters.` };
  const answers = draft.answers.map(answer => ({ ...answer, text: answer.text.trim() })).filter(answer => answer.text !== "");
  if (answers.length === 0) return { error: "Add at least one answer." };
  if (answers.length > POLL_MAX_ANSWERS) return { error: `A poll can have at most ${POLL_MAX_ANSWERS} answers.` };
  if (answers.some(answer => answer.text.length > POLL_ANSWER_MAX)) return { error: `Answers can be at most ${POLL_ANSWER_MAX} characters.` };
  return {
    request: {
      question: { text: question },
      answers: answers.map(answer => ({ poll_media: answer.emoji ? { text: answer.text, emoji: answer.emoji } : { text: answer.text } })),
      duration: draft.duration,
      allow_multiselect: draft.multiselect,
    },
  };
}

export interface PollResultSummary {
  question: string;
  total: number;
  winner: { id: number; text: string; votes: number; emoji: ReactionEmoji | null } | null;
}

/** Reads the "poll_result" embed of a type 46 message. */
export function resultSummary(embeds: Embed[]): PollResultSummary | null {
  const embed = embeds.find(e => e.type === "poll_result");
  if (!embed) return null;
  const field = (name: string) => embed.fields?.find(f => f.name === name)?.value;
  const id = Number(field("victor_answer_id"));
  const emojiName = field("victor_answer_emoji_name");
  const winner = Number.isInteger(id) && id > 0
    ? { id, text: field("victor_answer_text") ?? "", votes: Number(field("victor_answer_votes") ?? 0), emoji: emojiName ? { id: field("victor_answer_emoji_id") ?? null, name: emojiName } : null }
    : null;
  return { question: field("poll_question_text") ?? "", total: Number(field("total_votes") ?? 0), winner };
}
