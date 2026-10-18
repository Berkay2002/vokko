// Mock of docs/api.md "Polls": poll messages, votes (single choice moves, multiselect), voters, End Poll Now and the expiry sweep, with the
// server's status and error codes and the same events (MESSAGE_POLL_VOTE_ADD/REMOVE, MESSAGE_UPDATE, the type 46 result message).

import { MessageType, POLL_ANSWER_MAX, POLL_MAX_ANSWERS, POLL_QUESTION_MAX, type Embed, type User } from "../types";
import { Perm, hasBit } from "../permissions";
import { channelPermsOf } from "./access";
import { db, nextId, sortedMessages, userOf, type MockChannel, type MockMessage } from "./db";
import { addMessage, channelAudience, fail, requireChannel, requireChannelPerm, requireMessage } from "./ops";
import { ID, route, str } from "./router";
import { emit } from "./socket";
import { checkRulesAccepted } from "./community";
import { assertDmOpen } from "./settings";
import { assertThreadOpen } from "./threads";
import { polls, resultEmbeds, type MockPoll } from "./pollData";
import { messageFor } from "./views";

const invalid: (field: string, message: string) => never = (field, message) => fail(400, 50035, "Invalid Form Body", { [field]: { code: "BASE_TYPE_BAD_LENGTH", message } });

/** Validates `CreateMessageRequest.poll` (same bounds as the server). */
export function parsePoll(raw: unknown): Omit<MockPoll, "finalized"> {
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const media = (value: unknown) => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
  const question = (str(media(body.question).text) ?? "").trim();
  if (question === "" || question.length > POLL_QUESTION_MAX) invalid("poll.question.text", `Must be between 1 and ${POLL_QUESTION_MAX} in length.`);
  const rawAnswers = Array.isArray(body.answers) ? body.answers : [];
  if (rawAnswers.length === 0 || rawAnswers.length > POLL_MAX_ANSWERS) invalid("poll.answers", "A poll needs 1 to 10 answers.");
  const answers = rawAnswers.map((entry, index) => {
    const pollMedia = media(media(entry).poll_media);
    const text = (str(pollMedia.text) ?? "").trim();
    if (text === "" || text.length > POLL_ANSWER_MAX) invalid("poll.answers.poll_media.text", `Must be between 1 and ${POLL_ANSWER_MAX} in length.`);
    const emoji = media(pollMedia.emoji);
    const name = str(emoji.name);
    return { answer_id: index + 1, text, emoji: name ? { id: str(emoji.id) ?? null, name } : null, voters: [] as string[] };
  });
  const duration = body.duration === undefined ? 24 : Number(body.duration);
  if (!Number.isInteger(duration) || duration < 1 || duration > 768) invalid("poll.duration", "Must be between 1 and 768 hours.");
  return { question, answers, expiry: Date.now() + duration * 3_600_000, allow_multiselect: body.allow_multiselect === true };
}

function resultEmbed(poll: MockPoll): Embed {
  const total = poll.answers.reduce((sum, a) => sum + a.voters.length, 0);
  const fields = [
    { name: "poll_question_text", value: poll.question },
    { name: "total_votes", value: String(total) },
  ];
  const top = Math.max(0, ...poll.answers.map(a => a.voters.length));
  const leaders = poll.answers.filter(a => a.voters.length === top);
  const winner = top > 0 && leaders.length === 1 ? leaders[0] : undefined;
  if (winner) {
    fields.push({ name: "victor_answer_id", value: String(winner.answer_id) }, { name: "victor_answer_text", value: winner.text }, { name: "victor_answer_votes", value: String(top) });
    if (winner.emoji?.id) fields.push({ name: "victor_answer_emoji_id", value: winner.emoji.id });
    if (winner.emoji) fields.push({ name: "victor_answer_emoji_name", value: winner.emoji.name });
  }
  return { type: "poll_result", fields };
}

function locate(messageId: string): { channel: MockChannel; message: MockMessage } | null {
  for (const channel of db.channels.values()) {
    const message = sortedMessages(channel.id).find(m => m.id === messageId);
    if (message) return { channel, message };
  }
  return null;
}

/** Ends a poll once: MESSAGE_UPDATE with the final results, then the type 46 result message. False when it already ended. */
function finalize(messageId: string): boolean {
  const poll = polls.get(messageId);
  const found = locate(messageId);
  if (!poll || poll.finalized || !found) return false;
  poll.finalized = true;
  poll.expiry = Math.min(poll.expiry, Date.now());
  for (const id of channelAudience(found.channel)) emit([id], "MESSAGE_UPDATE", messageFor(found.message, id));
  // The embed is registered before the message exists so its MESSAGE_CREATE already carries it.
  const id = nextId();
  resultEmbeds.set(id, resultEmbed(poll));
  addMessage({ id, channel: found.channel, author_id: found.message.author_id, content: "", type: MessageType.PollResult, reference_id: messageId, allowEveryone: false });
  return true;
}

/** Ends every poll whose expiry passed (the server sweeps every few seconds); returns how many. */
export function sweepExpiredPolls(now = Date.now()): number {
  let ended = 0;
  for (const [id, poll] of polls) {
    if (!poll.finalized && poll.expiry <= now && finalize(id)) ended += 1;
  }
  return ended;
}

/** Test hook: move a poll's expiry. */
export function setPollExpiry(messageId: string, expiry: number): void {
  const poll = polls.get(messageId);
  if (poll) poll.expiry = expiry;
}

/**
 * Same order as the server's vote_target / list_voters: the answer id's shape (400), the channel and message (404), read
 * permission, for a vote the archived thread (403), and whether the message has a poll (404). Whether the answer exists
 * is `pollAnswer`, checked later, so the DM rule (403) comes before it like on the server.
 */
function target(viewerId: string, channelId: string, messageId: string, answerRaw: string, voting: boolean) {
  const answerId = Number(answerRaw);
  if (!Number.isInteger(answerId) || answerId <= 0 || answerId > 0x7fffffff) invalid("answer_id", "Unknown answer.");
  const channel = requireChannel(channelId, viewerId);
  const message = requireMessage(channel.id, messageId);
  requireChannelPerm(channel, viewerId, Perm.READ_MESSAGE_HISTORY);
  if (voting) assertThreadOpen(channel);
  const poll = polls.get(message.id);
  if (!poll) fail(404, 10008, "Unknown Message");
  return { channel, message, poll, answerId };
}

/** Like the server's open_poll: for a vote, an ended poll answers 520001 before an unknown answer is considered. */
function pollAnswer(poll: MockPoll, answerId: number, voting: boolean) {
  if (voting && (poll.finalized || poll.expiry <= Date.now())) fail(400, 520001, "Poll expired");
  const answer = poll.answers.find(a => a.answer_id === answerId);
  if (!answer) invalid("answer_id", "Unknown answer.");
  return answer;
}

function voteEvent(channel: MockChannel, userId: string, messageId: string, answerId: number) {
  return { user_id: userId, channel_id: channel.id, message_id: messageId, guild_id: channel.guild_id, answer_id: answerId };
}

route("PUT", `/channels/${ID}/polls/${ID}/answers/(\\d+)/@me`, ({ viewer, params }) => {
  const { channel, message, poll, answerId } = target(viewer.user.id, params[0] ?? "", params[1] ?? "", params[2] ?? "", true);
  assertDmOpen(channel, viewer.user.id);
  checkRulesAccepted(channel.guild_id, viewer.user.id);
  const answer = pollAnswer(poll, answerId, true);
  const me = viewer.user.id;
  if (!poll.allow_multiselect) {
    for (const other of poll.answers) {
      if (other !== answer && other.voters.includes(me)) {
        other.voters = other.voters.filter(id => id !== me);
        emit(channelAudience(channel), "MESSAGE_POLL_VOTE_REMOVE", voteEvent(channel, me, message.id, other.answer_id));
      }
    }
  }
  if (!answer.voters.includes(me)) {
    answer.voters.push(me);
    emit(channelAudience(channel), "MESSAGE_POLL_VOTE_ADD", voteEvent(channel, me, message.id, answer.answer_id));
  }
  return undefined;
});

route("DELETE", `/channels/${ID}/polls/${ID}/answers/(\\d+)/@me`, ({ viewer, params }) => {
  const { channel, message, poll, answerId } = target(viewer.user.id, params[0] ?? "", params[1] ?? "", params[2] ?? "", true);
  const answer = pollAnswer(poll, answerId, true);
  if (answer.voters.includes(viewer.user.id)) {
    answer.voters = answer.voters.filter(id => id !== viewer.user.id);
    emit(channelAudience(channel), "MESSAGE_POLL_VOTE_REMOVE", voteEvent(channel, viewer.user.id, message.id, answer.answer_id));
  }
  return undefined;
});

route("GET", `/channels/${ID}/polls/${ID}/answers/(\\d+)`, ({ viewer, params, query }) => {
  const { poll, answerId } = target(viewer.user.id, params[0] ?? "", params[1] ?? "", params[2] ?? "", false);
  const limit = Number(query.get("limit") ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid("limit", "Must be between 1 and 100.");
  const answer = pollAnswer(poll, answerId, false);
  const after = BigInt(query.get("after") ?? "0");
  const users: User[] = [...answer.voters].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).filter(id => BigInt(id) > after).slice(0, limit).map(userOf);
  return { users };
});

route("POST", `/channels/${ID}/polls/${ID}/expire`, ({ viewer, params }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  const message = requireMessage(channel.id, params[1] ?? "");
  if (!polls.has(message.id)) fail(400, 520006, "Cannot expire a non-poll message");
  if (message.author_id !== viewer.user.id) fail(403, 50005, "Cannot edit a message authored by another user");
  if (!finalize(message.id)) fail(400, 520001, "Poll expired");
  return messageFor(message, viewer.user.id);
});

/** Guild channels need SEND_POLLS for a poll message; DMs need nothing extra. */
export function requirePollPerm(channel: MockChannel, viewerId: string): void {
  if (channel.guild_id && !hasBit(channelPermsOf(channel, viewerId), Perm.SEND_POLLS)) fail(403, 50013, "Missing Permissions");
}
