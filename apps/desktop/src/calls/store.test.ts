import { describe, expect, it } from "vitest";
import { MessageType, type Call, type Message, type User } from "../api/types";
import { callDuration, callReducer, incomingCalls, initialCallModel, outgoingRinging, type CallModel } from "./store";
import { callNoticeKind } from "./CallNotice";
import { wantedTone } from "./engine";

const call = (over: Partial<Omit<Call, "voice_states">> = {}): Omit<Call, "voice_states"> => ({ channel_id: "10", message_id: "100", region: null, ringing: ["2"], ...over });
const ready = (): CallModel => callReducer(initialCallModel, { type: "ready", meId: "2" });

describe("call store", () => {
  it("CALL_CREATE / CALL_UPDATE / CALL_DELETE keep one entry per DM", () => {
    let model = callReducer(ready(), { type: "create", call: call() });
    expect(model.calls["10"]).toEqual({ channelId: "10", messageId: "100", region: null, ringing: ["2"] });
    model = callReducer(model, { type: "update", call: call({ ringing: [], region: "eu" }) });
    expect(model.calls["10"]).toMatchObject({ ringing: [], region: "eu" });
    model = callReducer(model, { type: "delete", channelId: "10" });
    expect(model.calls).toEqual({});
    expect(callReducer(model, { type: "delete", channelId: "10" })).toBe(model);
  });

  it("an incoming ring shows until answered elsewhere, declined, dismissed or the call ends", () => {
    let model = callReducer(ready(), { type: "create", call: call() });
    expect(incomingCalls(model, null).map(c => c.channelId)).toEqual(["10"]);
    // We are in that call already (accepted on this device): no overlay.
    expect(incomingCalls(model, "10")).toEqual([]);
    model = callReducer(model, { type: "dismiss", channelId: "10" });
    expect(incomingCalls(model, null)).toEqual([]);
    // Rung again ("Ring" from the caller after a stop): it comes back.
    model = callReducer(model, { type: "update", call: call({ ringing: [] }) });
    model = callReducer(model, { type: "update", call: call({ ringing: ["2"] }) });
    expect(incomingCalls(model, null)).toHaveLength(1);
    // Ring timeout / decline: CALL_UPDATE without us.
    model = callReducer(model, { type: "update", call: call({ ringing: [] }) });
    expect(incomingCalls(model, null)).toEqual([]);
  });

  it("a dismissed call does not hide the next call in the same DM", () => {
    let model = callReducer(ready(), { type: "create", call: call() });
    model = callReducer(model, { type: "dismiss", channelId: "10" });
    model = callReducer(model, { type: "delete", channelId: "10" });
    model = callReducer(model, { type: "create", call: call({ message_id: "101" }) });
    expect(incomingCalls(model, null).map(c => c.messageId)).toEqual(["101"]);
  });

  it("READY drops the calls (the server re-sends CALL_CREATE after it)", () => {
    const model = callReducer(callReducer(ready(), { type: "create", call: call() }), { type: "ready", meId: "2" });
    expect(model.calls).toEqual({});
  });

  it("outgoing ringing lists everyone rung except us", () => {
    const model = callReducer(ready(), { type: "create", call: call({ ringing: ["2", "3", "4"] }) });
    expect(outgoingRinging(model, "10")).toEqual(["3", "4"]);
    expect(outgoingRinging(model, "99")).toEqual([]);
  });

  it("tones: ring for an incoming call, ringback while we wait alone, silence once someone answers", () => {
    const voice = (channelId: string | null, inside: string[]) => ({ channelId, meId: "2", states: Object.fromEntries(inside.map(id => [id, { channel_id: channelId }])) });
    const incoming = callReducer(ready(), { type: "create", call: call() });
    expect(wantedTone(incoming, voice(null, []))).toBe("incoming");
    const outgoing = callReducer(ready(), { type: "create", call: call({ ringing: ["3"] }) });
    expect(wantedTone(outgoing, voice("10", ["2"]))).toBe("outgoing");
    expect(wantedTone(outgoing, voice("10", ["2", "4"])), "someone else is in the call").toBeNull();
    expect(wantedTone(callReducer(outgoing, { type: "update", call: call({ ringing: [] }) }), voice("10", ["2"]))).toBeNull();
    expect(wantedTone(ready(), voice(null, []))).toBeNull();
  });

  it("call rows: ongoing, ended, missed; durations in words", () => {
    const author = { id: "1" } as User;
    const message = (call: Message["call"]): Message => ({ id: "100", channel_id: "10", author, type: MessageType.Call, timestamp: "2026-10-12T18:00:00.000Z", call }) as Message;
    expect(callNoticeKind(message(undefined), "2")).toBe("ongoing");
    expect(callNoticeKind(message({ participants: ["1"], ended_timestamp: null }), "2")).toBe("ongoing");
    expect(callNoticeKind(message({ participants: ["1", "2"], ended_timestamp: "2026-10-12T18:05:00.000Z" }), "2")).toBe("ended");
    expect(callNoticeKind(message({ participants: ["1"], ended_timestamp: "2026-10-12T18:05:00.000Z" }), "2")).toBe("missed");
    expect(callNoticeKind(message({ participants: ["1"], ended_timestamp: "2026-10-12T18:05:00.000Z" }), "1"), "the caller did not miss it").toBe("ended");
    expect(callDuration("2026-10-12T18:00:00Z", "2026-10-12T18:00:12Z")).toBe("a few seconds");
    expect(callDuration("2026-10-12T18:00:00Z", "2026-10-12T18:01:10Z")).toBe("a minute");
    expect(callDuration("2026-10-12T18:00:00Z", "2026-10-12T18:25:00Z")).toBe("25 minutes");
    expect(callDuration("2026-10-12T18:00:00Z", "2026-10-12T19:05:00Z")).toBe("an hour");
    expect(callDuration("2026-10-12T18:00:00Z", "2026-10-12T21:00:00Z")).toBe("3 hours");
  });
});
