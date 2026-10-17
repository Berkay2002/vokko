import { describe, expect, it } from "vitest";
import type { VoiceState } from "../api/types";
import { channelOccupants, initialVoiceModel, isSpeaking, playbackVolume, stageRoster, voiceReducer, type VoiceAction, type VoiceModel } from "./reducer";

const ME = "100";
const ALICE = "200";
const BOB = "300";
const GUILD = "10";
const GENERAL = "20";
const GAMING = "21";

function vs(user: string, channel: string | null, extra: Partial<VoiceState> = {}): VoiceState {
  return {
    guild_id: GUILD,
    channel_id: channel,
    user_id: user,
    session_id: `s-${user}`,
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute: false,
    self_video: false,
    self_stream: false,
    suppress: false,
    request_to_speak_timestamp: null,
    connected_at: "2026-10-11T10:00:00.000Z",
    ...extra,
  };
}

const ready = (states: VoiceState[] = [], voiceEnabled = true): VoiceAction => ({ type: "ready", meId: ME, voiceEnabled, guilds: [{ id: GUILD, voice_states: states }] });
const update = (state: VoiceState): VoiceAction => ({ type: "voiceStateUpdate", state });
const server = (token: string, channelId = GENERAL, sessionId = "s-me-1"): VoiceAction => ({ type: "voiceServerUpdate", guildId: GUILD, channelId, endpoint: "wss://sfu.example", token, sessionId });

function apply(...actions: VoiceAction[]): VoiceModel {
  return actions.reduce(voiceReducer, initialVoiceModel);
}

/** A model where we are connected to #General with session s-me-1, Alice in the same channel. */
function joined(): VoiceModel {
  return apply(
    ready([vs(ALICE, GENERAL)]),
    { type: "join", guildId: GUILD, channelId: GENERAL },
    server("t1"),
    update(vs(ME, GENERAL, { session_id: "s-me-1" })),
    { type: "transportStatus", status: "connected" },
  );
}

describe("voice reducer: READY / GUILD_CREATE", () => {
  it("indexes voice states from READY by user and reads media.voice_enabled", () => {
    const m = apply(ready([vs(ALICE, GENERAL), vs(BOB, GAMING)]));
    expect(m.meId).toBe(ME);
    expect(m.enabled).toBe(true);
    expect(channelOccupants(m, GENERAL).map(s => s.user_id)).toEqual([ALICE]);
    expect(channelOccupants(m, GAMING).map(s => s.user_id)).toEqual([BOB]);
    expect(apply(ready([], false)).enabled).toBe(false);
  });

  it("GUILD_CREATE replaces only that guild's states; GUILD_DELETE drops them", () => {
    const other: VoiceState = { ...vs(BOB, "99"), guild_id: "11" };
    let m = apply(ready([vs(ALICE, GENERAL)]), { type: "guildCreate", guild: { id: "11", voice_states: [other] } });
    expect(Object.keys(m.states).sort()).toEqual([ALICE, BOB]);
    m = voiceReducer(m, { type: "guildCreate", guild: { id: GUILD, voice_states: [] } });
    expect(Object.keys(m.states)).toEqual([BOB]);
    m = voiceReducer(m, { type: "guildDelete", guildId: "11" });
    expect(m.states).toEqual({});
  });

  it("a re-READY keeps our own call so the engine can re-send op 4", () => {
    const m = voiceReducer(joined(), ready([vs(ALICE, GENERAL), vs(ME, GENERAL, { session_id: "s-me-1" })]));
    expect(m.channelId).toBe(GENERAL);
    expect(m.sessionId).toBe("s-me-1");
    expect(m.status).toBe("connected");
  });
});

describe("voice reducer: VOICE_STATE_UPDATE for others", () => {
  it("adds, moves and removes (channel_id null) other users", () => {
    let m = apply(ready());
    m = voiceReducer(m, update(vs(ALICE, GENERAL)));
    expect(channelOccupants(m, GENERAL).map(s => s.user_id)).toEqual([ALICE]);
    m = voiceReducer(m, update(vs(ALICE, GAMING)));
    expect(channelOccupants(m, GENERAL)).toEqual([]);
    expect(channelOccupants(m, GAMING).map(s => s.user_id)).toEqual([ALICE]);
    m = voiceReducer(m, update(vs(ALICE, null)));
    expect(m.states[ALICE]).toBeUndefined();
  });

  it("lists occupants in join order", () => {
    const m = apply(ready([vs(BOB, GENERAL, { connected_at: "2026-10-11T10:05:00.000Z" }), vs(ALICE, GENERAL, { connected_at: "2026-10-11T10:01:00.000Z" })]));
    expect(channelOccupants(m, GENERAL).map(s => s.user_id)).toEqual([ALICE, BOB]);
  });

  it("drops a leaving user's speaking flag", () => {
    let m = voiceReducer(joined(), { type: "speaking", userIds: [ALICE] });
    expect(isSpeaking(m, ALICE)).toBe(true);
    m = voiceReducer(m, update(vs(ALICE, null)));
    expect(m.speaking[ALICE]).toBeUndefined();
  });
});

describe("voice reducer: joining", () => {
  it("join → server update → own state adopts the session id and channel", () => {
    let m = apply(ready(), { type: "join", guildId: GUILD, channelId: GENERAL });
    expect(m).toMatchObject({ channelId: GENERAL, pendingJoin: true, status: "connecting", sessionId: null });
    m = voiceReducer(m, server("t1", GENERAL, "abc"));
    expect(m.server).toEqual({ endpoint: "wss://sfu.example", token: "t1" });
    m = voiceReducer(m, update(vs(ME, GENERAL, { session_id: "abc" })));
    expect(m).toMatchObject({ pendingJoin: false, sessionId: "abc", channelId: GENERAL, guildId: GUILD });
    expect(channelOccupants(m, GENERAL).map(s => s.user_id)).toEqual([ME]);
    m = voiceReducer(m, { type: "transportStatus", status: "rtc_connecting" });
    expect(m.status).toBe("rtc_connecting");
    m = voiceReducer(m, { type: "transportStatus", status: "connected" });
    expect(m.status).toBe("connected");
  });

  it("ignores a VOICE_SERVER_UPDATE when not joining or for another channel", () => {
    expect(apply(ready(), server("t1")).server).toBeNull();
    const m = apply(ready(), { type: "join", guildId: GUILD, channelId: GENERAL }, server("t1", GAMING));
    expect(m.server).toBeNull();
  });

  it("a repeated token is a no-op, a new token (move / refresh) replaces it", () => {
    const m = joined();
    expect(voiceReducer(m, server("t1"))).toBe(m);
    const moved = voiceReducer(voiceReducer(m, { type: "join", guildId: GUILD, channelId: GAMING }), server("t2", GAMING, "s-me-2"));
    expect(moved.server?.token).toBe("t2");
    expect(moved.status).toBe("connecting");
  });

  it("moving channels: the old session's null does not end the pending join", () => {
    let m = voiceReducer(joined(), { type: "join", guildId: GUILD, channelId: GAMING });
    m = voiceReducer(m, server("t2", GAMING, "s-me-2"));
    m = voiceReducer(m, update(vs(ME, null, { session_id: "s-me-1" })));
    expect(m.channelId).toBe(GAMING);
    expect(m.pendingJoin).toBe(true);
    m = voiceReducer(m, update(vs(ME, GAMING, { session_id: "s-me-2" })));
    expect(m).toMatchObject({ channelId: GAMING, sessionId: "s-me-2", pendingJoin: false });
  });

  it("joining the channel we are already in is a no-op", () => {
    const m = joined();
    expect(voiceReducer(m, { type: "join", guildId: GUILD, channelId: GENERAL })).toBe(m);
  });
});

describe("voice reducer: VOICE_CONNECT_FAILED", () => {
  it("shows the reason and clears the pending join", () => {
    const m = apply(ready(), { type: "join", guildId: GUILD, channelId: GENERAL }, { type: "connectFailed", guildId: GUILD, channelId: GENERAL, reason: "channel_full" });
    expect(m).toMatchObject({ channelId: null, pendingJoin: false, server: null, error: { reason: "channel_full", channelId: GENERAL } });
  });

  it("a refused move keeps the current call", () => {
    let m = voiceReducer(joined(), { type: "join", guildId: GUILD, channelId: GAMING });
    m = voiceReducer(m, { type: "connectFailed", guildId: GUILD, channelId: GAMING, reason: "missing_permissions" });
    expect(m).toMatchObject({ channelId: GENERAL, sessionId: "s-me-1", pendingJoin: false, status: "connected", error: { reason: "missing_permissions" } });
  });

  it("is ignored when nothing is pending for that channel", () => {
    const m = joined();
    expect(voiceReducer(m, { type: "connectFailed", guildId: GUILD, channelId: GAMING, reason: "channel_full" })).toBe(m);
  });
});

describe("voice reducer: leaving and being moved", () => {
  it("local leave clears the call and drops our own entry optimistically", () => {
    const m = voiceReducer(joined(), { type: "leave" });
    expect(m).toMatchObject({ channelId: null, sessionId: null, server: null, status: "disconnected", speaking: {} });
    expect(m.states[ME]).toBeUndefined();
    expect(m.states[ALICE]).toBeDefined();
    // The server's echo afterwards changes nothing.
    expect(voiceReducer(m, update(vs(ME, null, { session_id: "s-me-1" }))).channelId).toBeNull();
  });

  it("server-side removal (channel_id null for our session) ends the call", () => {
    const m = voiceReducer(joined(), update(vs(ME, null, { session_id: "s-me-1" })));
    expect(m.channelId).toBeNull();
    expect(m.status).toBe("disconnected");
  });

  it("own state with a session id we did not ask for = moved to another device → local disconnect", () => {
    const m = voiceReducer(joined(), update(vs(ME, GENERAL, { session_id: "other-device" })));
    expect(m).toMatchObject({ channelId: null, sessionId: null, server: null, error: { reason: "moved", channelId: GENERAL } });
    // We are still listed (on the other device).
    expect(m.states[ME]?.session_id).toBe("other-device");
  });

  it("own state from another device while idle is just listed", () => {
    const m = apply(ready(), update(vs(ME, GAMING, { session_id: "phone" })));
    expect(m.channelId).toBeNull();
    expect(m.error).toBeNull();
    expect(channelOccupants(m, GAMING).map(s => s.user_id)).toEqual([ME]);
  });

  it("same session with a new channel = server move: follow it", () => {
    const m = voiceReducer(joined(), update(vs(ME, GAMING, { session_id: "s-me-1" })));
    expect(m.channelId).toBe(GAMING);
    expect(m.sessionId).toBe("s-me-1");
  });

  it("transport closed: non-final reconnects, final leaves with the reason", () => {
    const retry = voiceReducer(joined(), { type: "transportClosed", final: false });
    expect(retry).toMatchObject({ status: "reconnecting", channelId: GENERAL, server: null });
    // A fresh token while reconnecting keeps the "reconnecting" label until the transport reports connected.
    expect(voiceReducer(retry, server("t9")).status).toBe("reconnecting");
    const kicked = voiceReducer(joined(), { type: "transportClosed", final: true, reason: "kicked" });
    expect(kicked).toMatchObject({ channelId: null, error: { reason: "kicked", channelId: GENERAL } });
  });

  it("guild delete while in one of its channels leaves", () => {
    expect(voiceReducer(joined(), { type: "guildDelete", guildId: GUILD }).channelId).toBeNull();
  });
});

describe("voice reducer: speaking", () => {
  it("rings only for users in our call, never for muted users, and not before we join", () => {
    const notJoined = apply(ready([vs(ALICE, GENERAL)]), { type: "speaking", userIds: [ALICE] });
    expect(isSpeaking(notJoined, ALICE)).toBe(false);
    let m = voiceReducer(joined(), update(vs(BOB, GAMING)));
    m = voiceReducer(m, { type: "speaking", userIds: [ALICE, BOB] });
    expect(isSpeaking(m, ALICE)).toBe(true);
    expect(isSpeaking(m, BOB)).toBe(false);
    m = voiceReducer(m, update(vs(ALICE, GENERAL, { self_mute: true })));
    expect(isSpeaking(m, ALICE)).toBe(false);
    m = voiceReducer(m, update(vs(ALICE, GENERAL, { mute: true })));
    expect(isSpeaking(m, ALICE)).toBe(false);
  });

  it("remote speaker updates keep the local self-speaking flag", () => {
    let m = voiceReducer(joined(), { type: "selfSpeaking", speaking: true });
    expect(m.speaking[ME]).toBe(true);
    m = voiceReducer(m, { type: "speaking", userIds: [ALICE] });
    expect(Object.keys(m.speaking).sort()).toEqual([ME, ALICE].sort());
    m = voiceReducer(m, { type: "selfSpeaking", speaking: false });
    expect(Object.keys(m.speaking)).toEqual([ALICE]);
  });

  it("self speaking is ignored while self muted", () => {
    const m = voiceReducer(voiceReducer(joined(), { type: "setSelfMute", mute: true }), { type: "selfSpeaking", speaking: true });
    expect(m.speaking[ME]).toBeUndefined();
  });
});

describe("voice reducer: self mute / deafen", () => {
  it("deafen mutes too; undeafen restores the previous mute", () => {
    let m = voiceReducer(joined(), { type: "setSelfDeaf", deaf: true });
    expect(m).toMatchObject({ selfDeaf: true, selfMute: true });
    m = voiceReducer(m, { type: "setSelfDeaf", deaf: false });
    expect(m).toMatchObject({ selfDeaf: false, selfMute: false });
    m = voiceReducer(m, { type: "setSelfMute", mute: true });
    m = voiceReducer(m, { type: "setSelfDeaf", deaf: true });
    m = voiceReducer(m, { type: "setSelfDeaf", deaf: false });
    expect(m).toMatchObject({ selfDeaf: false, selfMute: true });
  });

  it("unmuting while deafened undeafens", () => {
    let m = voiceReducer(joined(), { type: "setSelfDeaf", deaf: true });
    m = voiceReducer(m, { type: "setSelfMute", mute: false });
    expect(m).toMatchObject({ selfDeaf: false, selfMute: false });
  });
});

describe("voice reducer: per-user volume and local mute", () => {
  it("clamps to 0..200 %, 100 % is the default and is not stored", () => {
    let m = voiceReducer(initialVoiceModel, { type: "setUserVolume", userId: ALICE, volume: 250 });
    expect(m.volumes[ALICE]).toBe(200);
    expect(playbackVolume(m, ALICE)).toBe(2);
    m = voiceReducer(m, { type: "setUserVolume", userId: ALICE, volume: -5 });
    expect(playbackVolume(m, ALICE)).toBe(0);
    m = voiceReducer(m, { type: "setUserVolume", userId: ALICE, volume: 100 });
    expect(m.volumes).toEqual({});
    expect(playbackVolume(m, BOB)).toBe(1);
  });

  it("local mute plays at 0 and keeps the chosen volume for later", () => {
    let m = voiceReducer(initialVoiceModel, { type: "setUserVolume", userId: ALICE, volume: 150 });
    m = voiceReducer(m, { type: "setLocalMute", userId: ALICE, muted: true });
    expect(playbackVolume(m, ALICE)).toBe(0);
    m = voiceReducer(m, { type: "setLocalMute", userId: ALICE, muted: false });
    expect(playbackVolume(m, ALICE)).toBe(1.5);
  });
});

describe("voice reducer: misc", () => {
  it("quality, devices and settings are stored", () => {
    let m = voiceReducer(joined(), { type: "quality", quality: "good", pingMs: 42 });
    expect(m).toMatchObject({ quality: "good", pingMs: 42 });
    expect(voiceReducer(m, { type: "quality", quality: "good", pingMs: 42 })).toBe(m); // the 2 s poll with no change is a no-op
    m = voiceReducer(m, { type: "devices", input: [{ deviceId: "a", label: "Mic" }], output: [], outputSelectable: false });
    expect(m.devices.input).toEqual([{ deviceId: "a", label: "Mic" }]);
    m = voiceReducer(m, { type: "settings", settings: { inputMode: "ptt", pttKey: "F13" } });
    expect(m.settings).toMatchObject({ inputMode: "ptt", pttKey: "F13", vadAuto: true });
  });

  it("dismissError clears the error and returns to idle when not in voice", () => {
    let m = apply(ready(), { type: "join", guildId: GUILD, channelId: GENERAL }, { type: "connectFailed", guildId: GUILD, channelId: GENERAL, reason: "timed_out" });
    m = voiceReducer(m, { type: "dismissError" });
    expect(m.error).toBeNull();
    expect(m.status).toBe("idle");
  });
});

describe("voice reducer: rejoin and client-side errors", () => {
  it("rejoin (re-identify / media retry) adopts the re-bound session without leaving", () => {
    let m = voiceReducer(joined(), { type: "rejoin" });
    expect(m.pendingJoin).toBe(true);
    m = voiceReducer(m, update(vs(ME, null, { session_id: "s-me-1" }))); // old binding dropped server-side
    expect(m.channelId).toBe(GENERAL);
    m = voiceReducer(m, server("t2", GENERAL, "s-me-2"));
    m = voiceReducer(m, update(vs(ME, GENERAL, { session_id: "s-me-2" })));
    expect(m).toMatchObject({ channelId: GENERAL, sessionId: "s-me-2", pendingJoin: false, server: { token: "t2" } });
  });

  it("rejoin is a no-op outside voice", () => {
    const m = apply(ready());
    expect(voiceReducer(m, { type: "rejoin" })).toBe(m);
  });

  it("a pre-check error leaves the current call alone", () => {
    const m = voiceReducer(joined(), { type: "error", error: { reason: "channel_full", channelId: GAMING } });
    expect(m).toMatchObject({ channelId: GENERAL, status: "connected", error: { reason: "channel_full" } });
  });
});

describe("voice reducer: adopting only our own session (VOICE_SERVER_UPDATE.session_id)", () => {
  it("a pending join does not adopt an own state whose session no VOICE_SERVER_UPDATE named", () => {
    let m = apply(ready(), { type: "join", guildId: GUILD, channelId: GENERAL });
    // Another device of ours joins / toggles before our op 4 is answered: listed, not adopted, no error.
    m = voiceReducer(m, update(vs(ME, GENERAL, { session_id: "phone" })));
    expect(m).toMatchObject({ channelId: GENERAL, pendingJoin: true, sessionId: null, error: null });
    m = voiceReducer(m, server("t1", GENERAL, "mine"));
    expect(m.sessionId).toBeNull(); // the listed state is the phone's
    m = voiceReducer(m, update(vs(ME, GENERAL, { session_id: "mine" })));
    expect(m).toMatchObject({ channelId: GENERAL, pendingJoin: false, sessionId: "mine" });
  });

  it("a retrying client (op 4 pending) that sees another device's session is moved, not adopting it", () => {
    let m = voiceReducer(joined(), { type: "transportClosed", final: false });
    m = voiceReducer(m, { type: "rejoin" });
    expect(m.pendingJoin).toBe(true);
    m = voiceReducer(m, update(vs(ME, GENERAL, { session_id: "device-b" })));
    expect(m).toMatchObject({ channelId: null, sessionId: null, pendingJoin: false, server: null, error: { reason: "moved", channelId: GENERAL } });
    expect(m.states[ME]?.session_id).toBe("device-b");
    // The answer to our op 4 arriving late changes nothing.
    expect(voiceReducer(m, server("t-late", GENERAL, "device-a-2"))).toBe(m);
  });

  it("after a VOICE_SERVER_UPDATE, an own state with yet another session = moved", () => {
    let m = apply(ready(), { type: "join", guildId: GUILD, channelId: GENERAL }, server("t1", GENERAL, "mine"));
    m = voiceReducer(m, update(vs(ME, GENERAL, { session_id: "other" })));
    expect(m).toMatchObject({ channelId: null, error: { reason: "moved" } });
  });

  it("a reissued token for the session we have answers the reconnect op 4 without a state update", () => {
    let m = voiceReducer(voiceReducer(joined(), { type: "transportClosed", final: false }), { type: "rejoin" });
    m = voiceReducer(m, server("t2", GENERAL, "s-me-1"));
    expect(m).toMatchObject({ pendingJoin: false, sessionId: "s-me-1", server: { token: "t2" }, status: "reconnecting" });
  });

  it("ignores an unasked VOICE_SERVER_UPDATE for a session that is not ours", () => {
    const m = joined();
    expect(voiceReducer(m, server("t9", GENERAL, "someone-else"))).toBe(m);
  });

  it("adopts only states named by a VOICE_SERVER_UPDATE, also when the state was listed first", () => {
    let m = voiceReducer(joined(), { type: "rejoin" });
    m = voiceReducer(m, update(vs(ME, GENERAL, { session_id: "s-me-2" }))); // re-identify: new binding's state first
    expect(m.channelId).toBe(null); // not named by any VOICE_SERVER_UPDATE yet, and we had a session: moved
    let n = voiceReducer(joined(), { type: "rejoin" });
    n = voiceReducer(n, server("t2", GENERAL, "s-me-2"));
    n = voiceReducer(n, update(vs(ME, GENERAL, { session_id: "s-me-2" })));
    expect(n).toMatchObject({ channelId: GENERAL, sessionId: "s-me-2", pendingJoin: false });
    const fresh = apply(ready([vs(ME, GENERAL, { session_id: "s-x" })]), { type: "join", guildId: GUILD, channelId: GENERAL }, server("t1", GENERAL, "s-x"));
    expect(fresh).toMatchObject({ sessionId: "s-x", pendingJoin: false, channelId: GENERAL });
  });
});

describe("voice reducer: voice channel status", () => {
  const voiceChannel = (id: string, status: string | null | undefined) => ({ id, type: 2, status });

  it("seeds from READY / GUILD_CREATE channels and follows VOICE_CHANNEL_STATUS_UPDATE / CHANNEL_UPDATE / CHANNEL_DELETE", () => {
    let m = apply({ type: "ready", meId: ME, voiceEnabled: true, guilds: [{ id: GUILD, voice_states: [], channels: [voiceChannel(GENERAL, "Raid night"), voiceChannel(GAMING, null)] }] });
    expect(m.channelStatus).toEqual({ [GENERAL]: "Raid night" });
    m = voiceReducer(m, { type: "channelStatus", channelId: GAMING, status: "Chill" });
    expect(m.channelStatus).toEqual({ [GENERAL]: "Raid night", [GAMING]: "Chill" });
    m = voiceReducer(m, { type: "channelStatus", channelId: GENERAL, status: null });
    expect(m.channelStatus).toEqual({ [GAMING]: "Chill" });
    m = voiceReducer(m, { type: "channelUpdate", channel: voiceChannel(GAMING, "Ranked") });
    expect(m.channelStatus[GAMING]).toBe("Ranked");
    // A payload without the field (text channel, older server) leaves it alone.
    expect(voiceReducer(m, { type: "channelUpdate", channel: { id: GAMING, type: 2 } })).toBe(m);
    m = voiceReducer(m, { type: "guildCreate", guild: { id: GUILD, channels: [voiceChannel(GAMING, null), voiceChannel(GENERAL, "Back")] } });
    expect(m.channelStatus).toEqual({ [GENERAL]: "Back" });
    m = voiceReducer(m, { type: "channelDelete", channelId: GENERAL });
    expect(m.channelStatus).toEqual({});
  });
});

describe("voice reducer: server-side move and stages", () => {
  it("a VOICE_SERVER_UPDATE for our session in another channel (moderator move) is followed, not dropped", () => {
    const moved = voiceReducer(joined(), server("t-moved", GAMING, "s-me-1"));
    expect(moved).toMatchObject({ channelId: GAMING, sessionId: "s-me-1", server: { token: "t-moved" }, pendingJoin: false, status: "connecting" });
    const after = voiceReducer(moved, update(vs(ME, GAMING, { session_id: "s-me-1" })));
    expect(after.channelId).toBe(GAMING);
    expect(after.error).toBeNull();
    // Another session's token for another channel is still ignored.
    expect(voiceReducer(joined(), server("t-x", GAMING, "s-other")).channelId).toBe(GENERAL);
  });

  it("tracks live stages from READY, STAGE_INSTANCE_* and channel / guild deletes", () => {
    const stage = { id: "1", guild_id: GUILD, channel_id: "30", topic: "AMA", privacy_level: 2 as const };
    let m = apply({ type: "ready", meId: ME, voiceEnabled: true, guilds: [{ id: GUILD, voice_states: [], stage_instances: [stage] }] });
    expect(m.stages["30"]?.topic).toBe("AMA");
    m = voiceReducer(m, { type: "stageInstance", instance: { ...stage, topic: "Renamed" }, ended: false });
    expect(m.stages["30"]?.topic).toBe("Renamed");
    m = voiceReducer(m, { type: "stageInstance", instance: stage, ended: true });
    expect(m.stages["30"]).toBeUndefined();
    m = voiceReducer(m, { type: "stageInstance", instance: stage, ended: false });
    expect(voiceReducer(m, { type: "channelDelete", channelId: "30" }).stages).toEqual({});
    expect(voiceReducer(m, { type: "guildDelete", guildId: GUILD }).stages).toEqual({});
  });

  it("tracks Watch Together sessions from READY, GUILD_CREATE, WATCH_TOGETHER_UPDATE and channel / guild deletes", () => {
    const session = { video_id: "dQw4w9WgXcQ", playing: true, position_ms: 0, updated_at_ms: 1000, started_by: ALICE, queue: [] as string[] };
    let m = apply({ type: "ready", meId: ME, voiceEnabled: true, guilds: [{ id: GUILD, voice_states: [], watch_together: [{ channel_id: GENERAL, state: session }] }] });
    expect(m.watch[GENERAL]?.video_id).toBe("dQw4w9WgXcQ");
    m = voiceReducer(m, { type: "watchTogether", channelId: GENERAL, state: { ...session, playing: false, position_ms: 5000 } });
    expect(m.watch[GENERAL]).toMatchObject({ playing: false, position_ms: 5000 });
    m = voiceReducer(m, { type: "watchTogether", channelId: "99", state: { ...session, queue: ["aaaaaaaaaaa"] } });
    expect(Object.keys(m.watch).sort()).toEqual([GENERAL, "99"]);
    expect(voiceReducer(m, { type: "channelDelete", channelId: "99" }).watch[GENERAL]).toBeDefined();
    expect(voiceReducer(m, { type: "channelDelete", channelId: GENERAL }).watch[GENERAL]).toBeUndefined();
    const ended = voiceReducer(m, { type: "watchTogether", channelId: GENERAL, state: null });
    expect(ended.watch[GENERAL]).toBeUndefined();
    expect(voiceReducer(ended, { type: "watchTogether", channelId: GENERAL, state: null })).toBe(ended);
    // A later READY (reconnect) replaces the whole set.
    expect(voiceReducer(m, { type: "ready", meId: ME, voiceEnabled: true, guilds: [{ id: GUILD, voice_states: [] }] }).watch).toEqual({});
  });

  it("tracks Stremio sessions from READY, GUILD_CREATE, STREMIO_UPDATE and channel deletes", () => {
    const session = { item: { title: "Heat", label: "1080p" }, status: "starting" as const, playing: false, position_ms: 0, updated_at_ms: 1000, started_by: ALICE, bot_identity: `bot:stremio:${GENERAL}`, queue: [] };
    let m = apply({ type: "ready", meId: ME, voiceEnabled: true, guilds: [{ id: GUILD, voice_states: [], stremio: [{ channel_id: GENERAL, state: session }] }] });
    expect(m.stremio[GENERAL]?.item.title).toBe("Heat");
    m = voiceReducer(m, { type: "stremio", channelId: GENERAL, state: { ...session, status: "playing", playing: true } });
    expect(m.stremio[GENERAL]).toMatchObject({ status: "playing", playing: true });
    m = voiceReducer(m, { type: "stremio", channelId: "99", state: session });
    expect(Object.keys(m.stremio).sort()).toEqual([GENERAL, "99"]);
    expect(voiceReducer(m, { type: "channelDelete", channelId: GENERAL }).stremio[GENERAL]).toBeUndefined();
    const ended = voiceReducer(m, { type: "stremio", channelId: GENERAL, state: null });
    expect(ended.stremio[GENERAL]).toBeUndefined();
    expect(voiceReducer(ended, { type: "stremio", channelId: GENERAL, state: null })).toBe(ended);
    expect(voiceReducer(m, { type: "guildCreate", guild: { id: GUILD, voice_states: [], stremio: [{ channel_id: GENERAL, state: session }] } }).stremio[GENERAL]?.status).toBe("starting");
    expect(voiceReducer(m, { type: "ready", meId: ME, voiceEnabled: true, guilds: [{ id: GUILD, voice_states: [] }] }).stremio).toEqual({});
  });

  it("stageRoster splits speakers from the audience, raised hands first in raise order", () => {
    const m = apply(
      ready([
        vs(ALICE, "30", { suppress: false, connected_at: "2026-10-11T10:00:03.000Z" }),
        vs(BOB, "30", { suppress: true, connected_at: "2026-10-11T10:00:01.000Z" }),
        vs(ME, "30", { suppress: true, request_to_speak_timestamp: "2026-10-11T10:05:00.000Z", connected_at: "2026-10-11T10:00:02.000Z" }),
        vs("400", "30", { suppress: true, request_to_speak_timestamp: "2026-10-11T10:04:00.000Z", connected_at: "2026-10-11T10:00:04.000Z" }),
      ]),
    );
    const roster = stageRoster(m, "30");
    expect(roster.speakers.map(s => s.user_id)).toEqual([ALICE]);
    expect(roster.audience.map(s => s.user_id)).toEqual(["400", ME, BOB]);
  });
});
