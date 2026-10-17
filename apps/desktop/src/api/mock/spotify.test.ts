import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => [] as { to: string[] | string; t: string; d: unknown }[]);
vi.mock("./socket", () => ({
  emit: (users: Iterable<string>, t: string, d: unknown) => void events.push({ to: [...users], t, d }),
  emitToSession: (session: string, t: string, d: unknown) => void events.push({ to: session, t, d }),
}));

import { ChannelType, type SpotifyAlbum, type SpotifyReply, type SpotifySearchResults, type SpotifyState } from "../types";
import { db } from "./db";
import { addChannel, createAccount, createGuildRecord } from "./ops";
import { endStremio } from "./stremio";
import { handleRoute } from "./routes";
import { endSpotify, spotifyOf } from "./spotify";
import { guildPayload } from "./views";
import { handleVoiceStateUpdate, voiceStates } from "./voice";

const ids: Record<string, string> = {};
let guildId = "";
let voiceId = "";
let otherVoiceId = "";

const emit = (users: Iterable<string>, t: string, d: unknown) => void events.push({ to: [...users], t, d });
const emitToSession = (session: string, t: string, d: unknown) => void events.push({ to: session, t, d });
const op4 = (who: string, channel: string | null) =>
  handleVoiceStateUpdate(`gw-${who}`, ids[who]!, { guild_id: guildId, channel_id: channel, self_mute: false, self_deaf: false, self_video: false }, emit, emitToSession);
const call = (who: string, method: string, path: string, body: unknown = {}) => handleRoute(method, path, body, ids[who] ?? null);
const path = (channel = voiceId) => `/channels/${channel}/spotify`;
const errorOf = (fn: () => unknown): { status: number; code: number; message: string } | null => {
  try {
    fn();
    return null;
  } catch (error) {
    const e = error as { status: number; api: { code: number; message: string } };
    return { status: e.status, code: e.api.code, message: e.api.message };
  }
};
const search = (who: string, q: string, type = "track") => call(who, "GET", `/spotify/search?${new URLSearchParams({ q, type })}`) as SpotifySearchResults;
const discovery = () => search("owner", "discovery", "album").albums[0]!;

beforeEach(() => {
  vi.useFakeTimers();
  events.length = 0;
  voiceStates.clear();
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "plain", "other"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Spotify guild");
  const guild = db.guilds.get(guildId)!;
  const joined = new Date().toISOString();
  guild.members.set(ids.plain!, { nick: null, roles: [], joined_at: joined });
  guild.members.set(ids.other!, { nick: null, roles: [], joined_at: joined });
  const voice = [...db.channels.values()].filter(c => c.guild_id === guildId && c.type === ChannelType.GuildVoice);
  voiceId = voice[0]!.id;
  otherVoiceId = addChannel(guildId, { name: "lounge", type: ChannelType.GuildVoice }).id;
});

afterEach(() => {
  endSpotify(voiceId);
  endSpotify(otherVoiceId);
  endStremio(voiceId);
  call("owner", "DELETE", "/users/@me/stremio");
  vi.useRealTimers();
});

describe("mock Spotify catalog", () => {
  it("searches by type, looks up pasted links and refuses bad input", () => {
    expect(search("plain", "one more").tracks.map(t => t.title)).toEqual(["One More Time"]);
    expect(search("plain", "daft", "artist").tracks).toEqual([]);
    expect(search("plain", 'track:"get lucky" artist:"Daft Punk"').tracks.map(t => t.title)).toEqual(["Get Lucky"]);
    expect(search("plain", 'track:"get lucky" artist:"deadmau5"').tracks).toEqual([]);
    const album = discovery();
    expect(search("plain", `https://open.spotify.com/intl-de/album/${album.id}?si=x`).albums.map(a => a.name)).toEqual(["Discovery"]);
    expect(errorOf(() => search("plain", ""))?.code).toBe(50035);
    expect(errorOf(() => call("plain", "GET", "/spotify/albums/short"))?.code).toBe(50035);
    expect(errorOf(() => call("plain", "GET", `/spotify/albums/${"x".repeat(22)}`))).toMatchObject({ status: 404, code: 10200 });
    const full = call("plain", "GET", `/spotify/albums/${album.id}`) as SpotifyAlbum;
    expect(full.tracks.length).toBeGreaterThan(3);
    expect(full.tracks.every(t => /^spotify:track:[A-Za-z0-9]{22}$/.test(t.uri) && /^[0-9a-f]{40}$/.test(t.art ?? ""))).toBe(true);
  });
});

describe("mock Spotify session", () => {
  it("plays from one member, is controlled by another, queues, skips and ends with the call", () => {
    const tracks = search("owner", "daft").tracks;
    expect(errorOf(() => call("owner", "PUT", path(), { uri: tracks[0]!.uri }))).toMatchObject({ status: 403, code: 50013 });
    op4("owner", voiceId);
    op4("plain", voiceId);
    const started = call("owner", "PUT", path(), { uri: tracks[0]!.uri }) as SpotifyReply;
    expect(started).toMatchObject({ status: "starting", playing: true, started_by: ids.owner, bot_identity: `bot:spotify:${voiceId}`, queue_len: 0 });
    vi.advanceTimersByTime(500);
    expect(spotifyOf(voiceId)?.status).toBe("playing");

    call("plain", "PATCH", path(), { queue_add: { uri: tracks[1]!.uri } });
    const next = call("plain", "PATCH", path(), { queue_add: { uri: tracks[2]!.uri, next: true } }) as SpotifyReply;
    expect(next.queue.map(q => q.title)).toEqual([tracks[2]!.title, tracks[1]!.title]);
    expect(next.queue.every(q => q.added_by === ids.plain && q.qid)).toBe(true);
    expect(errorOf(() => call("plain", "PATCH", path(), { skip: true, shuffle: true }))?.code).toBe(50035);
    expect(errorOf(() => call("plain", "PATCH", path(), { queue_remove: "nope" }))?.code).toBe(50035);

    const skipped = call("owner", "PATCH", path(), { skip: true }) as SpotifyReply;
    expect(skipped.track?.title).toBe(tracks[2]!.title);
    expect(skipped.queue_len).toBe(1);
    expect(skipped.can_previous).toBe(true);
    // Previous within 3 s plays the last track again and puts the current one back in front.
    const back = call("owner", "PATCH", path(), { previous: true }) as SpotifyReply;
    expect(back.track?.title).toBe(tracks[0]!.title);
    expect(back.queue.map(q => q.title)).toEqual([tracks[2]!.title, tracks[1]!.title]);
    const removed = call("owner", "PATCH", path(), { queue_remove: back.queue[0]!.qid }) as SpotifyReply;
    expect(removed.queue_len).toBe(1);

    // A late joiner gets the session right after VOICE_SERVER_UPDATE; READY carries it too.
    events.length = 0;
    op4("other", voiceId);
    expect(events.some(e => e.to === "gw-other" && e.t === "SPOTIFY_UPDATE")).toBe(true);
    expect(guildPayload(guildId, ids.other!).spotify?.[0]?.channel_id).toBe(voiceId);

    // Everybody leaves: the session ends with an update of null.
    events.length = 0;
    for (const who of ["owner", "plain", "other"]) op4(who, null);
    expect(spotifyOf(voiceId)).toBeUndefined();
    expect(events.some(e => e.t === "SPOTIFY_UPDATE" && (e.d as { state: SpotifyState | null }).state === null)).toBe(true);
  });

  it("plays an album from its first track with the rest in front of the queue, and loops", () => {
    op4("owner", voiceId);
    const album = call("owner", "GET", `/spotify/albums/${discovery().id}`) as SpotifyAlbum;
    const reply = call("owner", "PUT", path(), { uri: `spotify:album:${album.id}` }) as SpotifyReply;
    expect(reply.track?.title).toBe(album.tracks[0]!.title);
    expect(reply.queue.map(q => q.title)).toEqual(album.tracks.slice(1).map(t => t.title));
    expect(errorOf(() => call("owner", "PUT", path(), { uri: `spotify:artist:${album.id}` }))?.code).toBe(50035);
    call("owner", "PATCH", path(), { loop: "queue" });
    vi.advanceTimersByTime(500);
    const first = spotifyOf(voiceId)!;
    // The track runs out: the next one plays and the finished one goes to the end of the queue.
    vi.advanceTimersByTime(first.track!.duration_ms + 10);
    const after = spotifyOf(voiceId)!;
    expect(after.track?.title).toBe(album.tracks[1]!.title);
    expect(after.queue.at(-1)?.title).toBe(album.tracks[0]!.title);
  });

  it("refuses a second channel (40035, naming it only for those who can see it) and a channel with a movie (40034)", () => {
    op4("owner", voiceId);
    const uri = search("owner", "get lucky").tracks[0]!.uri;
    call("owner", "PUT", path(), { uri });
    op4("plain", otherVoiceId);
    const busy = errorOf(() => call("plain", "PUT", path(otherVoiceId), { uri }));
    expect(busy).toMatchObject({ status: 409, code: 40035 });
    expect(busy?.message).toBe("Spotify is already playing in #General on Spotify guild (started by owner)");
    expect(errorOf(() => call("plain", "PATCH", path(otherVoiceId), { skip: true }))?.code).toBe(40033);

    // The movie and the music never share a channel, either way round.
    call("owner", "POST", "/users/@me/stremio/login", { email: "o@example.com", password: "secret" });
    const sid = () => (call("owner", "GET", "/stremio/streams/movie/tt0113277") as { streams: { sid: string; playable: boolean }[] }).streams.find(x => x.playable)!.sid;
    expect(errorOf(() => call("owner", "PUT", `/channels/${voiceId}/stremio`, { sid: sid() }))).toMatchObject({ status: 409, code: 40034 });
    call("owner", "DELETE", path());
    call("owner", "PUT", `/channels/${voiceId}/stremio`, { sid: sid() });
    expect(errorOf(() => call("owner", "PUT", path(), { uri }))).toMatchObject({ status: 409, code: 40034 });
  });
});
