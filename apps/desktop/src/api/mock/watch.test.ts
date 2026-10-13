import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => [] as { to: string[] | string; t: string; d: unknown }[]);
vi.mock("./socket", () => ({
  emit: (users: Iterable<string>, t: string, d: unknown) => void events.push({ to: [...users], t, d }),
  emitToSession: (session: string, t: string, d: unknown) => void events.push({ to: session, t, d }),
}));

import { ChannelType, type WatchTogetherState } from "../types";
import { db } from "./db";
import { createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";
import { guildPayload } from "./views";
import { handleVoiceStateUpdate, voiceStates } from "./voice";
import { watchOf } from "./watch";

const ID = "dQw4w9WgXcQ";
const NEXT = "aaaaaaaaaaa";
const ids: Record<string, string> = {};
let guildId = "";
let voiceId = "";

const emit = (users: Iterable<string>, t: string, d: unknown) => void events.push({ to: [...users], t, d });
const emitToSession = (session: string, t: string, d: unknown) => void events.push({ to: session, t, d });
const op4 = (who: string, channel: string | null) =>
  handleVoiceStateUpdate(`gw-${who}`, ids[who]!, { guild_id: guildId, channel_id: channel, self_mute: false, self_deaf: false, self_video: false }, emit, emitToSession);
const call = (who: string, method: string, path: string, body: unknown = {}) => handleRoute(method, path, body, ids[who] ?? null);
const path = () => `/channels/${voiceId}/watch-together`;
const errorOf = (fn: () => unknown): { status: number; code: number } | null => {
  try {
    fn();
    return null;
  } catch (error) {
    const e = error as { status: number; api: { code: number } };
    return { status: e.status, code: e.api.code };
  }
};
const updates = () => events.filter(e => e.t === "WATCH_TOGETHER_UPDATE");

beforeEach(() => {
  events.length = 0;
  voiceStates.clear();
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "plain", "other"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Watch guild");
  const guild = db.guilds.get(guildId)!;
  const joined = new Date().toISOString();
  guild.members.set(ids.plain!, { nick: null, roles: [], joined_at: joined });
  guild.members.set(ids.other!, { nick: null, roles: [], joined_at: joined });
  voiceId = [...db.channels.values()].find(c => c.guild_id === guildId && c.type === ChannelType.GuildVoice)!.id;
});

describe("mock Watch Together", () => {
  it("needs the caller to be in that voice channel and a real video id", () => {
    expect(errorOf(() => call("plain", "PUT", path(), { video_id: ID }))).toEqual({ status: 403, code: 50013 });
    op4("plain", voiceId);
    expect(errorOf(() => call("plain", "PUT", path(), { video_id: "short" }))?.status).toBe(400);
    expect(errorOf(() => call("plain", "PATCH", path(), { playing: false }))?.status).toBe(400);
    expect(watchOf(voiceId)).toBeUndefined();
  });

  it("start, pause, seek, queue, skip and stop each reach everyone who can see the channel", () => {
    op4("plain", voiceId);
    op4("other", voiceId);
    call("plain", "PUT", path(), { video_id: ID });
    expect(watchOf(voiceId)).toMatchObject({ video_id: ID, playing: true, position_ms: 0, started_by: ids.plain });
    expect(updates().at(-1)?.to).toEqual(expect.arrayContaining([ids.plain, ids.other, ids.owner]));

    call("other", "PATCH", path(), { playing: false, position_ms: 12_000 });
    expect(watchOf(voiceId)).toMatchObject({ playing: false, position_ms: 12_000 });
    expect(errorOf(() => call("other", "PATCH", path(), { position_ms: 90_000_000 }))?.status).toBe(400);

    call("other", "PATCH", path(), { queue_add: NEXT });
    expect(watchOf(voiceId)?.queue).toEqual([NEXT]);
    // A stale skip (the video already moved on) does nothing.
    call("plain", "PATCH", path(), { skip: true, video_id: "bbbbbbbbbbb" });
    expect(watchOf(voiceId)?.video_id).toBe(ID);
    call("plain", "PATCH", path(), { skip: true, video_id: ID });
    expect(watchOf(voiceId)).toMatchObject({ video_id: NEXT, playing: true, position_ms: 0, queue: [] });

    const before = updates().length;
    call("plain", "DELETE", path());
    expect(watchOf(voiceId)).toBeUndefined();
    expect(updates()).toHaveLength(before + 1);
    expect((updates().at(-1)?.d as { state: unknown }).state).toBeNull();
  });

  it("skipping with an empty queue ends it, and so does the last person leaving voice", () => {
    op4("plain", voiceId);
    call("plain", "PUT", path(), { video_id: ID });
    call("plain", "PATCH", path(), { skip: true });
    expect(watchOf(voiceId)).toBeUndefined();

    op4("other", voiceId);
    call("plain", "PUT", path(), { video_id: ID });
    op4("plain", null);
    expect(watchOf(voiceId)).toBeDefined();
    op4("other", null);
    expect(watchOf(voiceId)).toBeUndefined();
    expect((updates().at(-1)?.d as { state: unknown }).state).toBeNull();
  });

  it("READY / GUILD_CREATE carry the running session", () => {
    op4("plain", voiceId);
    call("plain", "PUT", path(), { video_id: ID });
    const payload = guildPayload(guildId, ids.other!) as { watch_together?: { channel_id: string; state: WatchTogetherState }[] };
    expect(payload.watch_together?.map(w => [w.channel_id, w.state.video_id])).toEqual([[voiceId, ID]]);
  });
});
