import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => [] as { to: string[] | string; t: string; d: unknown }[]);
vi.mock("./socket", () => ({
  emit: (users: Iterable<string>, t: string, d: unknown) => void events.push({ to: [...users], t, d }),
  emitToSession: (session: string, t: string, d: unknown) => void events.push({ to: session, t, d }),
}));

import { Perm, parseBits } from "../permissions";
import { ChannelType, type SpotifyReply, type StremioStream, type StremioStreams } from "../types";
import { db } from "./db";
import { skipNeeded } from "./mediaControl";
import { createAccount, createGuildRecord, openGroupDM } from "./ops";
import { handleRoute } from "./routes";
import { endSpotify, spotifyOf } from "./spotify";
import { endStremio, stremioOf } from "./stremio";
import { handleVoiceStateUpdate, voiceStates } from "./voice";
import { endWatch, watchOf } from "./watch";

const VIDEO = "dQw4w9WgXcQ";
const [A, B, C, D] = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"];
const ids: Record<string, string> = {};
let guildId = "";
let voiceId = "";

const emit = (users: Iterable<string>, t: string, d: unknown) => void events.push({ to: [...users], t, d });
const emitToSession = (session: string, t: string, d: unknown) => void events.push({ to: session, t, d });
/** Joins (or leaves with null) a little after the previous join, so "in the call longest" is well defined. */
const op4 = (who: string, channel: string | null, selfDeaf = false, guild: string | null = guildId) => {
  vi.advanceTimersByTime(5);
  handleVoiceStateUpdate(`gw-${who}`, ids[who]!, { guild_id: guild, channel_id: channel, self_mute: false, self_deaf: selfDeaf, self_video: false }, emit, emitToSession);
};
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
const watch = () => `/channels/${voiceId}/watch-together`;
const stremio = () => `/channels/${voiceId}/stremio`;
const spotify = () => `/channels/${voiceId}/spotify`;
const sid = (who: string): string => (call(who, "GET", "/stremio/streams/movie/tt0113277") as StremioStreams).streams.find((s: StremioStream) => s.playable)!.sid;
const track = (stem: string) => `spotify:track:${(stem + "0".repeat(22)).slice(0, 22)}`;
const DISCOVERY = `spotify:album:${"discovery".padEnd(22, "0")}`;

/** DJ mode: CONTROL_MEDIA off @everyone, so only the owner (and a session's host) control. */
const djMode = () => {
  const everyone = db.guilds.get(guildId)!.guild.roles.find(r => r.id === guildId)!;
  everyone.permissions = (parseBits(everyone.permissions) & ~Perm.CONTROL_MEDIA).toString();
};

beforeEach(() => {
  vi.useFakeTimers();
  events.length = 0;
  voiceStates.clear();
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "host", "b", "c"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Media guild");
  const guild = db.guilds.get(guildId)!;
  for (const name of ["host", "b", "c"]) guild.members.set(ids[name]!, { nick: null, roles: [], joined_at: new Date().toISOString() });
  voiceId = [...db.channels.values()].find(c => c.guild_id === guildId && c.type === ChannelType.GuildVoice)!.id;
  for (const name of ["host", "b", "c"]) call(name, "POST", "/users/@me/stremio/login", { email: `${name}@example.com`, password: "secret" });
});

afterEach(() => {
  endWatch(voiceId);
  endStremio(voiceId);
  endSpotify(voiceId);
  vi.useRealTimers();
});

describe("skip_needed", () => {
  it("is half the listeners rounded up, at least one", () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(skipNeeded)).toEqual([1, 1, 1, 2, 2, 3, 5]);
  });
});

describe("mock Watch Together control", () => {
  it("in DJ mode only the host controls; the others vote, queue up to 3 and cannot stop", () => {
    djMode();
    op4("host", voiceId);
    op4("b", voiceId);
    op4("c", voiceId);
    call("b", "PUT", watch(), { video_id: VIDEO }); // nothing runs: anyone may start, and hosts it
    expect(watchOf(voiceId)).toMatchObject({ host_id: ids.b, added_by: ids.b, skip_votes: [], skip_needed: 2 });
    for (const body of [{ playing: false }, { position_ms: 1000 }]) expect(errorOf(() => call("c", "PATCH", watch(), body))).toEqual({ status: 403, code: 50013 });
    expect(errorOf(() => call("c", "PUT", watch(), { video_id: A }))).toEqual({ status: 403, code: 50013 });
    expect(errorOf(() => call("c", "DELETE", watch()))).toEqual({ status: 403, code: 50013 });
    call("c", "PATCH", watch(), { title: "First" }); // the auto-fill while unset
    call("c", "PATCH", watch(), { title: "Second" }); // replacing it is a silent no-op
    expect(watchOf(voiceId)?.title).toBe("First");
    call("b", "PATCH", watch(), { playing: false }); // the host

    for (const id of [A, B, C]) call("c", "PATCH", watch(), { queue_add: id });
    expect(errorOf(() => call("c", "PATCH", watch(), { queue_add: D }))).toEqual({ status: 400, code: 50035 });
    expect(watchOf(voiceId)?.queue_added_by).toEqual([ids.c, ids.c, ids.c]);
  });

  it("votes skip at half the listeners, can be withdrawn, and the adder skips at once", () => {
    djMode();
    op4("host", voiceId);
    op4("b", voiceId);
    op4("c", voiceId);
    call("host", "PUT", watch(), { video_id: VIDEO });
    call("b", "PATCH", watch(), { queue_add: A });
    call("b", "PATCH", watch(), { skip: true, video_id: VIDEO });
    expect(watchOf(voiceId)).toMatchObject({ video_id: VIDEO, skip_votes: [ids.b], skip_needed: 2 });
    call("b", "PATCH", watch(), { skip: false });
    expect(watchOf(voiceId)?.skip_votes).toEqual([]);
    call("b", "PATCH", watch(), { skip: true, video_id: VIDEO });
    // A stale vote (for a video that is no longer current) does nothing.
    call("c", "PATCH", watch(), { skip: true, video_id: B });
    expect(watchOf(voiceId)?.skip_votes).toEqual([ids.b]);
    call("c", "PATCH", watch(), { skip: true, video_id: VIDEO });
    expect(watchOf(voiceId)).toMatchObject({ video_id: A, added_by: ids.b, skip_votes: [] });
    // b added A: b skips it without a vote (and the empty queue ends the session).
    call("b", "PATCH", watch(), { skip: true, video_id: A });
    expect(watchOf(voiceId)).toBeUndefined();
  });

  it("leaves and deafens recount: a lost listener can pass the vote, a voter who leaves loses it, the host moves on", () => {
    djMode();
    op4("host", voiceId);
    op4("b", voiceId);
    op4("c", voiceId);
    call("host", "PUT", watch(), { video_id: VIDEO });
    call("host", "PATCH", watch(), { queue_add: A });
    call("b", "PATCH", watch(), { skip: true });
    op4("b", null);
    expect(watchOf(voiceId)).toMatchObject({ skip_votes: [], skip_needed: 1 });
    op4("b", voiceId, true); // deafened: not a listener
    expect(watchOf(voiceId)?.skip_needed).toBe(1);
    call("c", "PATCH", watch(), { skip: true });
    expect(watchOf(voiceId)?.video_id).toBe(A);

    op4("b", voiceId); // undeafen: three listeners again
    expect(watchOf(voiceId)?.skip_needed).toBe(2);
    call("c", "PATCH", watch(), { skip: true });
    op4("b", null); // two listeners left: c's vote alone passes
    expect(watchOf(voiceId)).toBeUndefined();

    call("c", "PUT", watch(), { video_id: VIDEO });
    expect(watchOf(voiceId)?.host_id).toBe(ids.c);
    op4("c", null);
    expect(watchOf(voiceId)?.host_id).toBe(ids.host);
  });

  it("everyone controls with the default @everyone, and in a DM call", () => {
    op4("host", voiceId);
    op4("b", voiceId);
    call("host", "PUT", watch(), { video_id: VIDEO });
    call("b", "PATCH", watch(), { playing: false });
    expect(watchOf(voiceId)?.playing).toBe(false);
    for (const id of [A, B, C, D]) call("b", "PATCH", watch(), { queue_add: id });
    expect(watchOf(voiceId)?.queue).toHaveLength(4);
    call("b", "DELETE", watch());

    const dm = openGroupDM(ids.host!, [ids.b!, ids.c!]).id;
    op4("host", dm, false, null);
    op4("b", dm, false, null);
    call("host", "PUT", `/channels/${dm}/watch-together`, { video_id: VIDEO });
    call("b", "PATCH", `/channels/${dm}/watch-together`, { playing: false });
    expect(watchOf(dm)?.playing).toBe(false);
    endWatch(dm);
  });
});

describe("mock Stremio control", () => {
  it("non-controllers vote, queue 2, remove only their own entries and change no tracks", () => {
    djMode();
    op4("host", voiceId);
    op4("b", voiceId);
    op4("c", voiceId);
    call("host", "PUT", stremio(), { sid: sid("host") });
    vi.advanceTimersByTime(500);
    expect(stremioOf(voiceId)).toMatchObject({ host_id: ids.host, added_by: ids.host, skip_needed: 2, status: "playing" });
    for (const body of [{ playing: false }, { position_ms: 1000 }, { audio: 2 }, { burned_subtitle: 6 }]) expect(errorOf(() => call("b", "PATCH", stremio(), body))).toEqual({ status: 403, code: 50013 });
    expect(errorOf(() => call("b", "PUT", stremio(), { sid: sid("b") }))).toEqual({ status: 403, code: 50013 });
    expect(errorOf(() => call("b", "DELETE", stremio()))).toEqual({ status: 403, code: 50013 });

    call("host", "PATCH", stremio(), { queue_add: sid("host") });
    call("b", "PATCH", stremio(), { queue_add: sid("b") });
    call("b", "PATCH", stremio(), { queue_add: sid("b") });
    expect(errorOf(() => call("b", "PATCH", stremio(), { queue_add: sid("b") }))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => call("b", "PATCH", stremio(), { queue_remove: 0 }))).toEqual({ status: 403, code: 50013 });
    call("b", "PATCH", stremio(), { queue_remove: 2 });
    expect(stremioOf(voiceId)?.queue.map(q => q.added_by)).toEqual([ids.host, ids.b]);

    call("b", "PATCH", stremio(), { skip: true, item_seq: stremioOf(voiceId)!.item_seq + 1 }); // names an item that is not current
    expect(stremioOf(voiceId)?.skip_votes).toEqual([]);
    call("b", "PATCH", stremio(), { skip: true, item_seq: stremioOf(voiceId)!.item_seq });
    expect(stremioOf(voiceId)?.skip_votes).toEqual([ids.b]);
    call("c", "PATCH", stremio(), { skip: true });
    expect(stremioOf(voiceId)).toMatchObject({ added_by: ids.host, skip_votes: [], queue: [expect.objectContaining({ added_by: ids.b })] });
    call("host", "PATCH", stremio(), { skip: true });
    // b's title plays now: b skips it at once, which ends the session.
    expect(stremioOf(voiceId)?.added_by).toBe(ids.b);
    call("b", "PATCH", stremio(), { skip: true });
    expect(stremioOf(voiceId)).toBeUndefined();
  });
});

describe("mock Spotify control", () => {
  it("non-controllers vote, add up to 10 to the end, and an album adds what fits", () => {
    djMode();
    op4("host", voiceId);
    op4("b", voiceId);
    op4("c", voiceId);
    call("host", "PUT", spotify(), { uri: track("omt") });
    expect(spotifyOf(voiceId)).toMatchObject({ host_id: ids.host, added_by: ids.host, skip_needed: 2 });
    for (const body of [{ playing: false }, { position_ms: 1000 }, { previous: true }, { loop: "queue" }, { shuffle: true }, { queue_clear: true }, { queue_add: { uri: track("dafunk"), next: true } }]) {
      expect(errorOf(() => call("b", "PATCH", spotify(), body))).toEqual({ status: 403, code: 50013 });
    }
    expect(errorOf(() => call("b", "PUT", spotify(), { uri: track("dafunk") }))).toEqual({ status: 403, code: 50013 });
    expect(errorOf(() => call("b", "DELETE", spotify()))).toEqual({ status: 403, code: 50013 });

    call("host", "PATCH", spotify(), { queue_add: { uri: track("strobe") } });
    const first = call("b", "PATCH", spotify(), { queue_add: { uri: DISCOVERY } }) as SpotifyReply;
    expect(first.left_out).toBeUndefined();
    const second = call("b", "PATCH", spotify(), { queue_add: { uri: DISCOVERY } }) as SpotifyReply;
    expect(second.left_out).toBe(6); // 8 + 2 = 10 of b's own
    expect(errorOf(() => call("b", "PATCH", spotify(), { queue_add: { uri: track("dafunk") } }))).toEqual({ status: 400, code: 50035 });
    const hostEntry = spotifyOf(voiceId)!.queue[0]!;
    expect(errorOf(() => call("b", "PATCH", spotify(), { queue_remove: hostEntry.qid }))).toEqual({ status: 403, code: 50013 });
    call("b", "PATCH", spotify(), { queue_remove: spotifyOf(voiceId)!.queue[1]!.qid });

    const seq = spotifyOf(voiceId)!.item_seq;
    call("b", "PATCH", spotify(), { skip: true, item_seq: seq });
    expect(spotifyOf(voiceId)?.skip_votes).toEqual([ids.b]);
    call("c", "PATCH", spotify(), { skip: true, item_seq: seq });
    expect(spotifyOf(voiceId)).toMatchObject({ track: expect.objectContaining({ title: "Strobe" }), added_by: ids.host, skip_votes: [], item_seq: seq + 1 });
    // A vote for the track that just went is a no-op, and so is the host's skip.
    call("c", "PATCH", spotify(), { skip: true, item_seq: seq });
    call("host", "PATCH", spotify(), { skip: true, item_seq: seq });
    expect(spotifyOf(voiceId)).toMatchObject({ track: expect.objectContaining({ title: "Strobe" }), skip_votes: [], item_seq: seq + 1 });
  });
});
