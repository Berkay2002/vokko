import { beforeEach, describe, expect, it, vi } from "vitest";

const events: { users: string[]; t: string; d: unknown }[] = [];
vi.mock("./socket", () => ({
  emit: (users: Iterable<string>, t: string, d: unknown) => {
    events.push({ users: [...users], t, d });
  },
}));

import { ApiRequestError } from "../errors";
import { DEFAULT_EVERYONE, Perm } from "../permissions";
import { MessageType, type Channel, type Message, type PollAnswerVotersResponse, type PollVoteEvent } from "../types";
import { db } from "./db";
import { createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";
import { setPollExpiry, sweepExpiredPolls } from "./polls";

const ids: Record<string, string> = {};
let guildId = "";
let general = "";

const call = (who: string, method: string, path: string, body?: unknown): unknown => handleRoute(method, path, body ?? null, ids[who] ?? null);
const errorOf = (fn: () => unknown): { status: number; code: number } => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiRequestError) return { status: e.status, code: e.code };
    throw e;
  }
  throw new Error("expected the call to fail");
};
const pollBody = (answers: string[], multi = false) => ({ poll: { question: { text: "Lunch?" }, answers: answers.map(text => ({ poll_media: { text } })), duration: 4, allow_multiselect: multi } });
const createPoll = (who: string, answers = ["Pizza", "Sushi"], multi = false): Message => call(who, "POST", `/channels/${general}/messages`, pollBody(answers, multi)) as Message;
const vote = (who: string, mid: string, answer: number) => call(who, "PUT", `/channels/${general}/polls/${mid}/answers/${answer}/@me`);
const unvote = (who: string, mid: string, answer: number) => call(who, "DELETE", `/channels/${general}/polls/${mid}/answers/${answer}/@me`);
const messageAs = (who: string, mid: string): Message => (call(who, "GET", `/channels/${general}/messages`) as Message[]).find(m => m.id === mid)!;
const counts = (m: Message) => m.poll!.results.answer_counts.map(c => [c.count, c.me_voted]);
const voteEvents = () => events.filter(e => e.t.startsWith("MESSAGE_POLL_VOTE")).map(e => [e.t, (e.d as PollVoteEvent).answer_id]);
const results = (mid: string) => (call("owner", "GET", `/channels/${general}/messages`) as Message[]).filter(m => m.type === MessageType.PollResult && m.message_reference?.message_id === mid);
const field = (m: Message, name: string) => m.embeds[0]?.fields?.find(f => f.name === name)?.value;

beforeEach(() => {
  events.length = 0;
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending, db.followers] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "alice", "carol", "outsider"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Test guild");
  const guild = db.guilds.get(guildId)!;
  const joined = new Date().toISOString();
  guild.members.set(ids.alice!, { nick: null, roles: [], joined_at: joined });
  guild.members.set(ids.carol!, { nick: null, roles: [], joined_at: joined });
  general = [...db.channels.values()].find(c => c.guild_id === guildId && c.name === "general")!.id;
});

describe("mock polls", () => {
  it("creates a poll whose MESSAGE_CREATE carries it and counts votes per viewer", () => {
    const poll = createPoll("owner");
    expect(poll.poll?.question.text).toBe("Lunch?");
    expect(poll.poll?.answers.map(a => [a.answer_id, a.poll_media.text])).toEqual([[1, "Pizza"], [2, "Sushi"]]);
    const created = events.find(e => e.t === "MESSAGE_CREATE" && (e.d as Message).id === poll.id)!.d as Message;
    expect(created.poll?.results.answer_counts).toHaveLength(2);
    expect(Date.parse(poll.poll!.expiry) - Date.now()).toBeGreaterThan(3.9 * 3_600_000);

    vote("alice", poll.id, 1);
    expect(counts(messageAs("alice", poll.id))).toEqual([[1, true], [0, false]]);
    expect(counts(messageAs("owner", poll.id))).toEqual([[1, false], [0, false]]);
    const voters = call("carol", "GET", `/channels/${general}/polls/${poll.id}/answers/1`) as PollAnswerVotersResponse;
    expect(voters.users.map(u => u.id)).toEqual([ids.alice]);
  });

  it("moves a single-choice vote, keeps multiselect votes and ignores repeats", () => {
    const single = createPoll("owner", ["A", "B"]);
    vote("alice", single.id, 1);
    vote("alice", single.id, 2);
    vote("alice", single.id, 2);
    expect(voteEvents()).toEqual([["MESSAGE_POLL_VOTE_ADD", 1], ["MESSAGE_POLL_VOTE_REMOVE", 1], ["MESSAGE_POLL_VOTE_ADD", 2]]);
    expect(counts(messageAs("alice", single.id))).toEqual([[0, false], [1, true]]);
    unvote("alice", single.id, 2);
    expect(counts(messageAs("alice", single.id))).toEqual([[0, false], [0, false]]);

    const multi = createPoll("owner", ["A", "B"], true);
    vote("alice", multi.id, 1);
    vote("alice", multi.id, 2);
    expect(counts(messageAs("alice", multi.id))).toEqual([[1, true], [1, true]]);
  });

  it("validates polls and refuses edits, attachments' absence aside", () => {
    expect(errorOf(() => call("owner", "POST", `/channels/${general}/messages`, pollBody([])))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => call("owner", "POST", `/channels/${general}/messages`, pollBody(Array(11).fill("a"))))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => call("owner", "POST", `/channels/${general}/messages`, pollBody(["x".repeat(56)])))).toEqual({ status: 400, code: 50035 });
    const poll = createPoll("owner");
    expect(errorOf(() => call("owner", "PATCH", `/channels/${general}/messages/${poll.id}`, { content: "edited" }))).toEqual({ status: 400, code: 520003 });
    expect(errorOf(() => vote("alice", poll.id, 3))).toEqual({ status: 400, code: 50035 });
  });

  it("needs SEND_POLLS to create and READ_MESSAGE_HISTORY to vote", () => {
    const poll = createPoll("owner");
    const everyone = db.guilds.get(guildId)!.guild.roles.find(r => r.id === guildId)!;
    everyone.permissions = (DEFAULT_EVERYONE & ~Perm.SEND_POLLS).toString();
    expect(errorOf(() => createPoll("alice"))).toEqual({ status: 403, code: 50013 });
    everyone.permissions = (DEFAULT_EVERYONE & ~Perm.READ_MESSAGE_HISTORY).toString();
    expect(errorOf(() => vote("alice", poll.id, 1)).status).toBe(403);
    expect(errorOf(() => vote("outsider", poll.id, 1)).status).toBe(403);
  });

  it("End Poll Now: author only, finalises once, posts one result with the winner", () => {
    const poll = createPoll("owner");
    vote("alice", poll.id, 2);
    vote("carol", poll.id, 2);
    vote("owner", poll.id, 1);
    expect(errorOf(() => call("alice", "POST", `/channels/${general}/polls/${poll.id}/expire`))).toEqual({ status: 403, code: 50005 });
    events.length = 0;
    const ended = call("owner", "POST", `/channels/${general}/polls/${poll.id}/expire`) as Message;
    expect(ended.poll?.results.is_finalized).toBe(true);
    expect(events.some(e => e.t === "MESSAGE_UPDATE" && (e.d as Message).id === poll.id)).toBe(true);
    const created = events.find(e => e.t === "MESSAGE_CREATE")!.d as Message;
    expect(created.type).toBe(MessageType.PollResult);
    expect([field(created, "victor_answer_id"), field(created, "victor_answer_text"), field(created, "total_votes")]).toEqual(["2", "Sushi", "3"]);
    expect(errorOf(() => call("owner", "POST", `/channels/${general}/polls/${poll.id}/expire`))).toEqual({ status: 400, code: 520001 });
    expect(errorOf(() => vote("alice", poll.id, 1))).toEqual({ status: 400, code: 520001 });
    expect(sweepExpiredPolls()).toBe(0);
    expect(results(poll.id)).toHaveLength(1);
    const plain = call("owner", "POST", `/channels/${general}/messages`, { content: "hi" }) as Message;
    expect(errorOf(() => call("owner", "POST", `/channels/${general}/polls/${plain.id}/expire`))).toEqual({ status: 400, code: 520006 });
  });

  it("the sweep ends expired polls once; ties name no winner", () => {
    const poll = createPoll("owner");
    const open = createPoll("owner");
    vote("alice", poll.id, 1);
    vote("carol", poll.id, 2);
    setPollExpiry(poll.id, Date.now() - 1000);
    expect(errorOf(() => vote("owner", poll.id, 1))).toEqual({ status: 400, code: 520001 });
    expect(sweepExpiredPolls()).toBe(1);
    expect(sweepExpiredPolls()).toBe(0);
    const [result] = results(poll.id);
    expect(result && field(result, "victor_answer_id")).toBeUndefined();
    expect(result && field(result, "total_votes")).toBe("2");
    expect(messageAs("owner", open.id).poll?.results.is_finalized).toBe(false);
  });

  it("works in DMs without extra permissions", () => {
    const dm = call("alice", "POST", "/users/@me/channels", { recipient_id: ids.carol }) as Channel;
    const poll = call("alice", "POST", `/channels/${dm.id}/messages`, pollBody(["yes", "no"])) as Message;
    call("carol", "PUT", `/channels/${dm.id}/polls/${poll.id}/answers/1/@me`);
    expect((call("alice", "GET", `/channels/${dm.id}/messages`) as Message[])[0]!.poll?.results.answer_counts[0]?.count).toBe(1);
  });
});
