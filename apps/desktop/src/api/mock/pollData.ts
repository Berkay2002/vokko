// Poll rows of the mock (no imports beyond types, so views.ts can read them without pulling the route modules into an import cycle).

import type { Embed, Poll, ReactionEmoji } from "../types";

export interface MockPoll {
  question: string;
  answers: { answer_id: number; text: string; emoji: ReactionEmoji | null; voters: string[] }[];
  expiry: number;
  allow_multiselect: boolean;
  finalized: boolean;
}

/** Poll message id → poll. */
export const polls = new Map<string, MockPoll>();
/** Result message id → its "poll_result" embed. */
export const resultEmbeds = new Map<string, Embed>();

export function addPoll(messageId: string, poll: Omit<MockPoll, "finalized">): void {
  polls.set(messageId, { ...poll, finalized: false });
}

export const isPoll = (messageId: string): boolean => polls.has(messageId);

/** The wire poll for `viewerId` (undefined for messages without one). */
export function pollFor(messageId: string, viewerId: string): Poll | undefined {
  const poll = polls.get(messageId);
  if (!poll) return undefined;
  return {
    question: { text: poll.question },
    answers: poll.answers.map(a => ({ answer_id: a.answer_id, poll_media: a.emoji ? { text: a.text, emoji: { ...a.emoji } } : { text: a.text } })),
    expiry: new Date(poll.expiry).toISOString(),
    allow_multiselect: poll.allow_multiselect,
    layout_type: 1,
    results: { is_finalized: poll.finalized, answer_counts: poll.answers.map(a => ({ id: a.answer_id, count: a.voters.length, me_voted: a.voters.includes(viewerId) })) },
  };
}

export const pollEmbedsFor = (messageId: string): Embed[] => {
  const embed = resultEmbeds.get(messageId);
  return embed ? [structuredClone(embed)] : [];
};
