import { beforeEach, describe, expect, it, vi } from "vitest";

const socketEvents = vi.hoisted(() => [] as { users: string[]; t: string; d: unknown }[]);
vi.mock("./socket", () => ({
  emit: (users: Iterable<string>, t: string, d: unknown) => void socketEvents.push({ users: [...users], t, d }),
  emitToSession: (session: string, t: string, d: unknown) => void socketEvents.push({ users: [session], t, d }),
}));

import { ApiRequestError } from "../errors";
import { MessageType, RelationshipType, type Call, type Message } from "../types";
import { calls, ringTimeout, sendActiveCalls } from "./calls";
import { db, sortedMessages } from "./db";
import { createAccount, openDM, openGroupDM } from "./ops";
import { handleRoute } from "./routes";
import { setRelationship } from "./views";
import { handleVoiceStateUpdate, voiceStates } from "./voice";

const ids: Record<string, string> = {};
const events = (t: string) => socketEvents.filter(e => e.t === t);
const last = <T,>(t: string): T => events(t).at(-1)!.d as T;
const op4 = (who: string, channel: string | null) =>
  handleVoiceStateUpdate(`gw-${who}`, ids[who]!, { guild_id: null, channel_id: channel, self_mute: false, self_deaf: false, self_video: false }, (u, t, d) => void socketEvents.push({ users: [...u], t, d }), (s, t, d) => void socketEvents.push({ users: [s], t, d }));
const call = (who: string, method: string, path: string, body: unknown = {}) => handleRoute(method, path, body, ids[who]!);
const failure = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiRequestError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error("expected a failure");
};

beforeEach(() => {
  vi.useFakeTimers();
  socketEvents.length = 0;
  voiceStates.clear();
  calls.clear();
  ringTimeout.ms = 180_000;
  for (const map of [db.accounts, db.channels, db.messages] as Map<string, unknown>[]) map.clear();
  for (const name of ["sam", "bob", "carl"]) ids[name] = createAccount({ username: name }).user.id;
});

describe("mock DM calls", () => {
  it("the first join starts the call: type 3 message, CALL_CREATE ringing the other side, then answered", () => {
    const dm = openDM(ids.sam!, ids.bob!).id;
    op4("bob", dm);
    const message = sortedMessages(dm).at(-1)!;
    expect(message).toMatchObject({ type: MessageType.Call, author_id: ids.bob, call: { participants: [ids.bob], ended_timestamp: null } });
    const created = last<Call>("CALL_CREATE");
    expect(created).toMatchObject({ channel_id: dm, message_id: message.id, ringing: [ids.sam] });
    expect(created.voice_states.map(s => s.user_id)).toEqual([ids.bob]);
    expect(created.voice_states[0]!.guild_id).toBeNull();
    // Sam accepts.
    op4("sam", dm);
    expect(last<Call>("CALL_UPDATE").ringing).toEqual([]);
    expect(last<Message>("MESSAGE_UPDATE").call?.participants).toEqual([ids.bob, ids.sam]);
    // Reconnecting: CALL_CREATE right after READY.
    socketEvents.length = 0;
    sendActiveCalls("session-x", ids.sam!);
    expect(events("CALL_CREATE")).toHaveLength(1);
    // Both leave: ended.
    op4("bob", null);
    op4("sam", null);
    expect(last<{ channel_id: string }>("CALL_DELETE")).toEqual({ channel_id: dm });
    expect(last<Message>("MESSAGE_UPDATE").call?.ended_timestamp).toEqual(expect.any(String));
  });

  it("decline, ring again, region and the ring timeout", () => {
    const dm = openDM(ids.sam!, ids.bob!).id;
    op4("bob", dm);
    call("sam", "POST", `/channels/${dm}/call/stop-ringing`);
    expect(last<Call>("CALL_UPDATE").ringing).toEqual([]);
    call("bob", "POST", `/channels/${dm}/call/ring`);
    expect(last<Call>("CALL_UPDATE").ringing).toEqual([ids.sam]);
    expect(failure(() => call("bob", "PATCH", `/channels/${dm}/call`, { region: "Nope!" }))).toEqual({ status: 400, code: 50035 });
    call("bob", "PATCH", `/channels/${dm}/call`, { region: "eu-north" });
    expect(last<Call>("CALL_UPDATE").region).toBe("eu-north");
    expect(failure(() => call("sam", "POST", `/channels/${dm}/call/stop-ringing`, { recipients: [ids.bob] }))).toEqual({ status: 403, code: 50013 });
    expect(failure(() => call("sam", "POST", `/channels/${dm}/call/ring`)), "only people in the call can ring").toEqual({ status: 403, code: 50013 });
    socketEvents.length = 0;
    vi.advanceTimersByTime(180_000);
    expect(last<Call>("CALL_UPDATE").ringing, "missed after three minutes").toEqual([]);
    op4("bob", null);
    const message = sortedMessages(dm).at(-1)!;
    expect(message.call).toMatchObject({ participants: [ids.bob], ended_timestamp: expect.any(String) });
    expect(failure(() => call("bob", "POST", `/channels/${dm}/call/ring`))).toEqual({ status: 400, code: 50035 });
  });

  it("someone who joined and left can be rung again", () => {
    const dm = openDM(ids.sam!, ids.bob!).id;
    op4("bob", dm);
    op4("sam", dm);
    op4("sam", null);
    expect(last<Call>("CALL_UPDATE").ringing).toEqual([]);
    call("bob", "POST", `/channels/${dm}/call/ring`);
    expect(last<Call>("CALL_UPDATE").ringing).toEqual([ids.sam]);
  });

  it("leaving a group DM leaves its call and stops the ringing", () => {
    const group = openGroupDM(ids.sam!, [ids.bob!, ids.carl!]).id;
    op4("sam", group);
    expect(last<Call>("CALL_CREATE").ringing).toEqual([ids.bob!, ids.carl!].sort());
    call("carl", "DELETE", `/channels/${group}`);
    expect(last<Call>("CALL_UPDATE").ringing).toEqual([ids.bob]);
    op4("bob", group);
    call("bob", "DELETE", `/channels/${group}`);
    expect([...voiceStates.values()].filter(s => s.channel_id === group).map(s => s.user_id)).toEqual([ids.sam]);
  });

  it("blocks: no 1:1 call, no ringing in a group, and at most 10 people", () => {
    const dm = openDM(ids.sam!, ids.bob!).id;
    setRelationship(ids.bob!, ids.sam!, RelationshipType.Blocked, null);
    op4("sam", dm);
    expect(last<{ reason: string }>("VOICE_CONNECT_FAILED").reason).toBe("blocked");
    expect(calls.size).toBe(0);
    const group = openGroupDM(ids.sam!, [ids.bob!, ids.carl!]).id;
    op4("sam", group);
    expect(last<Call>("CALL_CREATE").ringing).toEqual([ids.carl]);
    expect(failure(() => call("sam", "POST", `/channels/${group}/call/ring`, { recipients: [ids.bob] }))).toEqual({ status: 403, code: 50007 });
    // Cap: a group with 11 recipients lets 10 in.
    const crowd = Array.from({ length: 11 }, (_, i) => createAccount({ username: `u${i}` }).user.id);
    const big = openGroupDM(crowd[0]!, crowd.slice(1, 9));
    big.participant_ids = crowd;
    for (const [i, id] of crowd.entries()) {
      ids[`u${i}`] = id;
      op4(`u${i}`, big.id);
    }
    expect([...voiceStates.values()].filter(s => s.channel_id === big.id)).toHaveLength(10);
    expect(last<{ reason: string }>("VOICE_CONNECT_FAILED").reason).toBe("channel_full");
  });
});
