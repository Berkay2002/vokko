import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => [] as { to: string[] | string; t: string; d: unknown }[]);
vi.mock("./socket", () => ({
  emit: (users: Iterable<string>, t: string, d: unknown) => void events.push({ to: [...users], t, d }),
  emitToSession: (session: string, t: string, d: unknown) => void events.push({ to: session, t, d }),
}));

import { Perm } from "../permissions";
import { ChannelType, type StageInstance, type VoiceState } from "../types";
import { db } from "./db";
import { addChannel, createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";
import { guildPayload } from "./views";
import { handleVoiceStateUpdate, stageInstances, voiceStates } from "./voice";

const ids: Record<string, string> = {};
let guildId = "";
let stageId = "";
let voiceId = "";
let loungeId = "";

const emit = (users: Iterable<string>, t: string, d: unknown) => void events.push({ to: [...users], t, d });
const emitToSession = (session: string, t: string, d: unknown) => void events.push({ to: session, t, d });
const op4 = (who: string, channel: string | null) =>
  handleVoiceStateUpdate(`gw-${who}`, ids[who]!, { guild_id: guildId, channel_id: channel, self_mute: false, self_deaf: false, self_video: false }, emit, emitToSession);
const call = (who: string, method: string, path: string, body: unknown = {}) => handleRoute(method, path, body, ids[who] ?? null);
const errorOf = (fn: () => unknown): { status: number; code: number } | null => {
  try {
    fn();
    return null;
  } catch (error) {
    const e = error as { status: number; api: { code: number } };
    return { status: e.status, code: e.api.code };
  }
};
const state = (who: string): VoiceState | undefined => voiceStates.get(ids[who]!);
const last = (t: string) => events.filter(e => e.t === t).at(-1);

beforeEach(() => {
  events.length = 0;
  voiceStates.clear();
  stageInstances.clear();
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "plain", "other"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Stage guild");
  const guild = db.guilds.get(guildId)!;
  const joined = new Date().toISOString();
  guild.members.set(ids.plain!, { nick: null, roles: [], joined_at: joined });
  guild.members.set(ids.other!, { nick: null, roles: [], joined_at: joined });
  voiceId = [...db.channels.values()].find(c => c.guild_id === guildId && c.type === ChannelType.GuildVoice)!.id;
  stageId = addChannel(guildId, { name: "Town Hall", type: ChannelType.GuildStage }).id;
  loungeId = addChannel(guildId, { name: "Lounge", type: ChannelType.GuildVoice }).id;
});

describe("mock stage channels", () => {
  it("everyone joins as audience; only moderators start, edit and end a stage", () => {
    op4("plain", stageId);
    expect(state("plain")).toMatchObject({ channel_id: stageId, suppress: true });
    expect(errorOf(() => call("plain", "POST", "/stage-instances", { channel_id: stageId, topic: "hi" }))).toEqual({ status: 403, code: 50013 });
    expect(errorOf(() => call("owner", "POST", "/stage-instances", { channel_id: stageId, topic: "" }))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => call("owner", "POST", "/stage-instances", { channel_id: voiceId, topic: "x" }))).toEqual({ status: 400, code: 50024 });
    const instance = call("owner", "POST", "/stage-instances", { channel_id: stageId, topic: "  Weekly sync " }) as StageInstance;
    expect(instance).toMatchObject({ channel_id: stageId, guild_id: guildId, topic: "Weekly sync", privacy_level: 2 });
    expect(last("STAGE_INSTANCE_CREATE")?.d).toEqual(instance);
    expect(errorOf(() => call("owner", "POST", "/stage-instances", { channel_id: stageId, topic: "again" }))).toEqual({ status: 400, code: 150006 });
    expect(guildPayload(guildId, ids.other!).stage_instances).toEqual([instance]);
    expect((call("owner", "PATCH", `/stage-instances/${stageId}`, { topic: "Renamed" }) as StageInstance).topic).toBe("Renamed");
    expect(errorOf(() => call("plain", "DELETE", `/stage-instances/${stageId}`))).toEqual({ status: 403, code: 50013 });
    call("owner", "DELETE", `/stage-instances/${stageId}`);
    expect(last("STAGE_INSTANCE_DELETE")?.d).toMatchObject({ channel_id: stageId });
    expect(errorOf(() => call("other", "GET", `/stage-instances/${stageId}`))).toEqual({ status: 404, code: 10067 });
  });

  it("raise hand, invite to speak, and the stage ends when the last moderator leaves", () => {
    op4("plain", stageId);
    op4("owner", stageId);
    call("owner", "POST", "/stage-instances", { channel_id: stageId, topic: "AMA" });
    const me = `/guilds/${guildId}/voice-states/@me`;
    call("plain", "PATCH", me, { channel_id: stageId, request_to_speak_timestamp: "2001-01-01T00:00:00Z" });
    expect(state("plain")?.request_to_speak_timestamp).not.toBe("2001-01-01T00:00:00Z");
    expect(state("plain")?.request_to_speak_timestamp).toBeTruthy();
    expect(errorOf(() => call("plain", "PATCH", me, { channel_id: stageId, suppress: false }))).toEqual({ status: 403, code: 50013 });
    expect(errorOf(() => call("other", "PATCH", me, { channel_id: stageId, request_to_speak_timestamp: null }))).toEqual({ status: 400, code: 40032 });
    const plainPath = `/guilds/${guildId}/voice-states/${ids.plain}`;
    expect(errorOf(() => call("other", "PATCH", plainPath, { channel_id: stageId, suppress: false }))).toEqual({ status: 403, code: 50013 });
    call("owner", "PATCH", plainPath, { channel_id: stageId, suppress: false });
    expect(state("plain")).toMatchObject({ suppress: false, request_to_speak_timestamp: null });
    // The moderator becomes a speaker, then leaves: no moderator left, stage over, speakers back to the audience.
    call("owner", "PATCH", me, { channel_id: stageId, suppress: false });
    op4("owner", null);
    expect(stageInstances.has(stageId)).toBe(false);
    expect(last("STAGE_INSTANCE_DELETE")?.d).toMatchObject({ topic: "AMA" });
    expect(state("plain")).toMatchObject({ suppress: true });
  });
});

describe("mock server mute / deafen / move / disconnect", () => {
  const patch = (who: string, target: string, body: unknown) => call(who, "PATCH", `/guilds/${guildId}/members/${ids[target]}`, body);

  it("needs MUTE_MEMBERS / DEAFEN_MEMBERS / MOVE_MEMBERS; flags persist and show in voice states", () => {
    op4("plain", voiceId);
    expect(errorOf(() => patch("other", "plain", { mute: true }))).toEqual({ status: 403, code: 50013 });
    expect(errorOf(() => patch("other", "plain", { channel_id: null }))).toEqual({ status: 403, code: 50013 });
    expect(errorOf(() => patch("owner", "other", { channel_id: loungeId }))).toEqual({ status: 400, code: 40032 });
    expect(patch("owner", "plain", { mute: true, deaf: true })).toMatchObject({ mute: true, deaf: true });
    expect(state("plain")).toMatchObject({ mute: true, deaf: true });
    op4("plain", null);
    op4("plain", voiceId);
    expect(state("plain")).toMatchObject({ mute: true, deaf: true });
  });

  it("move keeps the voice session and sends the moved user a token for the new channel; null disconnects", () => {
    op4("plain", voiceId);
    const session = state("plain")!.session_id;
    events.length = 0;
    patch("owner", "plain", { channel_id: loungeId });
    expect(state("plain")).toMatchObject({ channel_id: loungeId, session_id: session });
    expect(events.find(e => e.t === "VOICE_SERVER_UPDATE")).toMatchObject({ to: "gw-plain", d: { channel_id: loungeId, session_id: session } });
    // Not into a channel the user cannot connect to.
    db.channels.get(voiceId)!.permission_overwrites = [{ id: ids.plain!, type: 1, allow: "0", deny: Perm.CONNECT.toString() }];
    expect(errorOf(() => patch("owner", "plain", { channel_id: voiceId }))).toEqual({ status: 403, code: 50013 });
    patch("owner", "plain", { channel_id: null });
    expect(state("plain")).toBeUndefined();
  });
  it("the audience can't keep a camera or stream: suppressing a speaker turns both off", () => {
    const video = (who: string, on: boolean) =>
      handleVoiceStateUpdate(`gw-${who}`, ids[who]!, { guild_id: guildId, channel_id: stageId, self_mute: false, self_deaf: false, self_video: on, self_stream: on }, emit, emitToSession);
    op4("plain", stageId);
    video("plain", true);
    expect(state("plain")).toMatchObject({ suppress: true, self_video: false, self_stream: false });
    const plainPath = `/guilds/${guildId}/voice-states/${ids.plain}`;
    call("owner", "PATCH", plainPath, { channel_id: stageId, suppress: false });
    video("plain", true);
    expect(state("plain")).toMatchObject({ suppress: false, self_video: true, self_stream: true });
    call("owner", "PATCH", plainPath, { channel_id: stageId, suppress: true });
    expect(state("plain")).toMatchObject({ suppress: true, self_video: false, self_stream: false });
  });
});
