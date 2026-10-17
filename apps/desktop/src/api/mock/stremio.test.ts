import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => [] as { to: string[] | string; t: string; d: unknown }[]);
vi.mock("./socket", () => ({
  emit: (users: Iterable<string>, t: string, d: unknown) => void events.push({ to: [...users], t, d }),
  emitToSession: (session: string, t: string, d: unknown) => void events.push({ to: session, t, d }),
}));

import { ChannelType, STREMIO_QUEUE_MAX, type StremioState, type StremioStream, type StremioStreams } from "../types";
import { db } from "./db";
import { createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";
import { stremioOf } from "./stremio";
import { guildPayload } from "./views";
import { handleVoiceStateUpdate, voiceStates } from "./voice";

const ids: Record<string, string> = {};
let guildId = "";
let voiceId = "";

const emit = (users: Iterable<string>, t: string, d: unknown) => void events.push({ to: [...users], t, d });
const emitToSession = (session: string, t: string, d: unknown) => void events.push({ to: session, t, d });
const op4 = (who: string, channel: string | null) =>
  handleVoiceStateUpdate(`gw-${who}`, ids[who]!, { guild_id: guildId, channel_id: channel, self_mute: false, self_deaf: false, self_video: false }, emit, emitToSession);
const call = (who: string, method: string, path: string, body: unknown = {}) => handleRoute(method, path, body, ids[who] ?? null);
const path = () => `/channels/${voiceId}/stremio`;
const errorOf = (fn: () => unknown): { status: number; code: number } | null => {
  try {
    fn();
    return null;
  } catch (error) {
    const e = error as { status: number; api: { code: number } };
    return { status: e.status, code: e.api.code };
  }
};
const updates = () => events.filter(e => e.t === "STREMIO_UPDATE");
const link = (who: string) => call(who, "POST", "/users/@me/stremio/login", { email: `${who}@example.com`, password: "secret" });
const playable = (who: string, id = "tt0113277"): StremioStream[] => (call(who, "GET", `/stremio/streams/movie/${id}`) as StremioStreams).streams.filter(s => s.playable);

beforeEach(() => {
  vi.useFakeTimers();
  events.length = 0;
  voiceStates.clear();
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "plain", "other"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Stremio guild");
  const guild = db.guilds.get(guildId)!;
  const joined = new Date().toISOString();
  guild.members.set(ids.plain!, { nick: null, roles: [], joined_at: joined });
  guild.members.set(ids.other!, { nick: null, roles: [], joined_at: joined });
  voiceId = [...db.channels.values()].find(c => c.guild_id === guildId && c.type === ChannelType.GuildVoice)!.id;
});

afterEach(() => {
  call("owner", "DELETE", "/users/@me/stremio");
  call("plain", "DELETE", "/users/@me/stremio");
  vi.useRealTimers();
});

describe("mock Stremio account and browsing", () => {
  it("links with the email fallback, refuses a rejected password and unlinks", () => {
    expect(call("owner", "GET", "/users/@me/stremio")).toEqual({ linked: false });
    expect(errorOf(() => call("owner", "GET", "/stremio/streams/movie/tt0113277"))).toEqual({ status: 403, code: 50013 });
    expect(errorOf(() => call("owner", "POST", "/users/@me/stremio/login", { email: "a@b.se", password: "wrong" }))?.status).toBe(400);
    link("owner");
    expect(call("owner", "GET", "/users/@me/stremio")).toMatchObject({ linked: true });
    call("owner", "DELETE", "/users/@me/stremio");
    expect(call("owner", "GET", "/users/@me/stremio")).toEqual({ linked: false });
  });

  it("links with a code that polls until it is approved", () => {
    const start = call("owner", "POST", "/users/@me/stremio/link") as { code: string; link: string };
    expect(start.link).toContain(start.code);
    expect(call("owner", "POST", "/users/@me/stremio/link/poll")).toEqual({ linked: false });
  });

  it("searches Cinemeta-style titles and serves a series with its episodes", () => {
    const found = call("owner", "GET", "/stremio/search?type=series&q=breaking") as { id: string }[];
    expect(found.map(f => f.id)).toEqual(["tt0903747"]);
    expect(errorOf(() => call("owner", "GET", "/stremio/search?type=movie&q="))?.status).toBe(400);
    const meta = call("owner", "GET", "/stremio/meta/series/tt0903747") as { videos: { id: string; thumbnail?: string }[] };
    expect(meta.videos[0]).toMatchObject({ id: "tt0903747:1:1" });
    expect(meta.videos[0]?.thumbnail).toContain("episodes.metahub.space");
  });

  it("lists streams with disabled rows and the addon that failed, and needs an episode for a series", () => {
    link("owner");
    const listed = call("owner", "GET", "/stremio/streams/movie/tt0113277") as StremioStreams;
    expect(listed.addon_errors).toEqual(["TorBox"]);
    expect(listed.streams.filter(s => !s.playable).map(s => s.unsupported)).toEqual(["torrent", "youtube"]);
    expect(errorOf(() => call("owner", "GET", "/stremio/streams/series/tt0903747"))?.status).toBe(400);
    expect(JSON.stringify(listed)).not.toMatch(/https?:/);
  });
});

describe("mock Stremio sessions", () => {
  it("needs the caller in the voice channel and a stream of their own", () => {
    link("plain");
    link("other");
    const mine = playable("plain");
    expect(errorOf(() => call("plain", "PUT", path(), { sid: mine[0]!.sid }))).toEqual({ status: 403, code: 50013 });
    op4("plain", voiceId);
    op4("other", voiceId);
    expect(errorOf(() => call("plain", "PUT", path(), { sid: "nope" }))?.status).toBe(400);
    expect(errorOf(() => call("other", "PUT", path(), { sid: mine[0]!.sid }))?.status).toBe(400);
    expect(errorOf(() => call("plain", "PATCH", path(), { playing: false }))?.status).toBe(400);
    expect(stremioOf(voiceId)).toBeUndefined();
  });

  it("starts, becomes playing on its own, and follows pause, seek, queue, skip and stop from others in the call", () => {
    link("plain");
    link("other");
    op4("plain", voiceId);
    op4("other", voiceId);
    const first = playable("plain");
    const started = call("plain", "PUT", path(), { sid: first[1]!.sid }) as StremioState;
    expect(started).toMatchObject({ status: "starting", playing: true, started_by: ids.plain, bot_identity: `bot:stremio:${voiceId}`, item: { title: "Heat", label: "1080p WEB-DL" } });
    expect(JSON.stringify(started).replace(/https:\/\/images\.metahub\.space\S+?"/, "")).not.toMatch(/https?:/);
    vi.advanceTimersByTime(500);
    expect(stremioOf(voiceId)).toMatchObject({ status: "playing", duration_ms: 7_200_000 });

    call("other", "PATCH", path(), { playing: false, position_ms: 42_000 });
    expect(stremioOf(voiceId)).toMatchObject({ status: "paused", playing: false, position_ms: 42_000 });
    expect(errorOf(() => call("other", "PATCH", path(), { position_ms: 9_000_000 }))?.status).toBe(400);
    call("plain", "PATCH", path(), { playing: true });
    expect(stremioOf(voiceId)).toMatchObject({ status: "playing", playing: true });

    call("other", "PATCH", path(), { queue_add: playable("other", "tt1375666")[0]!.sid });
    expect(stremioOf(voiceId)?.queue).toMatchObject([{ title: "Inception", added_by: ids.other }]);
    call("plain", "PATCH", path(), { queue_add: playable("plain", "tt0133093")[0]!.sid });
    call("plain", "PATCH", path(), { queue_remove: 1 });
    expect(stremioOf(voiceId)?.queue.map(q => q.title)).toEqual(["Inception"]);
    call("plain", "PATCH", path(), { skip: true });
    expect(stremioOf(voiceId)).toMatchObject({ item: { title: "Inception" }, status: "starting", position_ms: 0, queue: [] });
    call("other", "PATCH", path(), { skip: true });
    expect(stremioOf(voiceId)).toBeUndefined();
    expect(updates().at(-1)?.d).toMatchObject({ channel_id: voiceId, state: null });
  });

  it("holds ten in the queue", () => {
    link("plain");
    op4("plain", voiceId);
    call("plain", "PUT", path(), { sid: playable("plain")[0]!.sid });
    for (let i = 0; i < STREMIO_QUEUE_MAX; i += 1) call("plain", "PATCH", path(), { queue_add: playable("plain")[1]!.sid });
    expect(errorOf(() => call("plain", "PATCH", path(), { queue_add: playable("plain")[1]!.sid }))?.status).toBe(400);
  });

  it("hands out a viewer token only to someone in the call while a session runs", () => {
    link("plain");
    op4("plain", voiceId);
    expect(errorOf(() => call("plain", "POST", `${path()}/viewer-token`))?.status).toBe(400);
    call("plain", "PUT", path(), { sid: playable("plain")[0]!.sid });
    expect(call("plain", "POST", `${path()}/viewer-token`)).toMatchObject({ url: "mock://stremio" });
    expect(errorOf(() => call("other", "POST", `${path()}/viewer-token`))).toEqual({ status: 403, code: 50013 });
  });

  it("goes with READY, a late joiner and the last person leaving", () => {
    link("plain");
    op4("plain", voiceId);
    call("plain", "PUT", path(), { sid: playable("plain")[0]!.sid });
    expect(guildPayload(guildId, ids.other!).stremio).toMatchObject([{ channel_id: voiceId, state: { item: { title: "Heat" } } }]);
    events.length = 0;
    op4("other", voiceId);
    expect(events.find(e => e.t === "STREMIO_UPDATE" && e.to === "gw-other")).toBeTruthy();
    op4("plain", null);
    expect(stremioOf(voiceId)).toBeDefined();
    op4("other", null);
    expect(stremioOf(voiceId)).toBeUndefined();
    expect(guildPayload(guildId, ids.other!).stremio).toBeUndefined();
  });
});
