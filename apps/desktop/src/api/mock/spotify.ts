// Mock Spotify in calls (docs/api.md "Spotify in calls"): a small public catalog, the browse routes, PUT / PATCH / DELETE / GET
// /channels/{id}/spotify, the listener token and SPOTIFY_UPDATE. Like the server there is at most one session on the whole mock
// (one house account), and at most one media activity per channel. A stand-in bot moves a new track from "starting" / "loading"
// to "playing" after a short delay and ends each track when its time is up.

import {
  ChannelType,
  SPOTIFY_EVENT_QUEUE_MAX,
  SPOTIFY_QUEUE_MAX,
  type SpotifyAlbum,
  type SpotifyAlbumSummary,
  type SpotifyArtist,
  type SpotifyArtistSummary,
  type SpotifyListenerToken,
  type SpotifyLoop,
  type SpotifyPlaylist,
  type SpotifyPlaylistSummary,
  type SpotifyQueueEntry,
  type SpotifyReply,
  type SpotifySearchResults,
  type SpotifyState,
  type SpotifyTrack,
  type SpotifyUpdate,
} from "../types";
import { canView } from "./access";
import { db, type MockChannel } from "./db";
import { fail, MISSING_PERMISSIONS, requireChannel } from "./ops";
import { ID, route } from "./router";
import { emit } from "./socket";
import { stremioOf } from "./stremio";
import { voiceAudience, voiceStates } from "./voice";

export const MOCK_SPOTIFY_ENDPOINT = "mock://spotify";
let botStartMs = 400;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const URI = /^spotify:(track|album|playlist|artist):([A-Za-z0-9]{22})$/;
const LINK = /^https:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist|artist)\/([A-Za-z0-9]{22})(?:\?.*)?$/;

const invalid = (field: string, message: string): never => fail(400, 50035, "Invalid Form Body", { [field]: { code: "INVALID", message } });
const unknownItem = (): never => fail(404, 10200, "Unknown Spotify item");

// ---- the catalog ----

/** A 22-character Spotify id from a short readable stem. */
const sid = (stem: string): string => (stem + "0".repeat(22)).slice(0, 22);
/** A 40-hex art id from a stem (the e2e answers i.scdn.co with a flat picture per id). */
const art = (stem: string): string => [...stem].map(c => c.charCodeAt(0).toString(16)).join("").padEnd(40, "0").slice(0, 40);

const DISCOVERY_ART = art("discovery");
const RAM_ART = art("ram");
const track = (stem: string, title: string, seconds: number, album: string, cover: string, artists = ["Daft Punk"]): SpotifyTrack => ({
  uri: `spotify:track:${sid(stem)}`,
  title,
  artists,
  album,
  art: cover,
  duration_ms: seconds * 1000,
  explicit: false,
});

const DISCOVERY: SpotifyTrack[] = [
  track("omt", "One More Time", 320, "Discovery", DISCOVERY_ART),
  track("aerodynamic", "Aerodynamic", 212, "Discovery", DISCOVERY_ART),
  track("digitallove", "Digital Love", 301, "Discovery", DISCOVERY_ART),
  track("harderbetter", "Harder, Better, Faster, Stronger", 224, "Discovery", DISCOVERY_ART),
  track("crescendolls", "Crescendolls", 211, "Discovery", DISCOVERY_ART),
  track("nightvision", "Nightvision", 104, "Discovery", DISCOVERY_ART),
  track("somethingabout", "Something About Us", 232, "Discovery", DISCOVERY_ART),
  track("veridis", "Veridis Quo", 345, "Discovery", DISCOVERY_ART),
];
const RAM: SpotifyTrack[] = [
  track("getlucky", "Get Lucky", 369, "Random Access Memories", RAM_ART, ["Daft Punk", "Pharrell Williams", "Nile Rodgers"]),
  track("instantcrush", "Instant Crush", 337, "Random Access Memories", RAM_ART, ["Daft Punk", "Julian Casablancas"]),
  track("lose", "Lose Yourself to Dance", 353, "Random Access Memories", RAM_ART, ["Daft Punk", "Pharrell Williams"]),
  track("giorgio", "Giorgio by Moroder", 544, "Random Access Memories", RAM_ART),
];
const OTHER: SpotifyTrack[] = [
  track("aroundworld", "Around the World", 429, "Homework", art("homework")),
  track("dafunk", "Da Funk", 328, "Homework", art("homework")),
  track("strobe", "Strobe", 634, "For Lack of a Better Name", art("strobe"), ["deadmau5"]),
];
const TRACKS = [...DISCOVERY, ...RAM, ...OTHER];

const ALBUMS: SpotifyAlbum[] = [
  { id: sid("discovery"), name: "Discovery", artists: ["Daft Punk"], art: DISCOVERY_ART, year: "2001", tracks: DISCOVERY },
  { id: sid("ram"), name: "Random Access Memories", artists: ["Daft Punk"], art: RAM_ART, year: "2013", tracks: RAM },
  { id: sid("homework"), name: "Homework", artists: ["Daft Punk"], art: art("homework"), year: "1997", tracks: OTHER.slice(0, 2) },
];
const ARTISTS: SpotifyArtist[] = [
  { id: sid("daftpunk"), name: "Daft Punk", art: art("daftpunk"), top_tracks: [DISCOVERY[0], RAM[0], DISCOVERY[3], OTHER[0], RAM[1]].filter((t): t is SpotifyTrack => !!t), albums: ALBUMS.map(summary) },
  { id: sid("deadmau5"), name: "deadmau5", art: art("deadmau5"), top_tracks: OTHER.slice(2), albums: [] },
];
const PLAYLISTS: SpotifyPlaylist[] = [
  { id: sid("fridaymix"), name: "Friday Daft Mix", owner_name: "Alex", art: art("fridaymix"), total: 6, tracks: [RAM[0], DISCOVERY[2], OTHER[0], DISCOVERY[0], RAM[1], OTHER[1]].filter((t): t is SpotifyTrack => !!t) },
];

function summary(album: SpotifyAlbum): SpotifyAlbumSummary {
  return { id: album.id, name: album.name, artists: [...album.artists], ...(album.art ? { art: album.art } : {}), ...(album.year ? { year: album.year } : {}) };
}

const artistSummary = ({ id, name, art: a }: SpotifyArtist): SpotifyArtistSummary => ({ id, name, ...(a ? { art: a } : {}) });
const playlistSummary = ({ id, name, owner_name, art: a }: SpotifyPlaylist): SpotifyPlaylistSummary => ({ id, name, owner_name, ...(a ? { art: a } : {}) });

const byId = <T extends { id: string }>(list: T[], id: string | undefined): T => {
  if (!SPOTIFY_ID.test(id ?? "")) invalid("id", "Not a Spotify id.");
  return list.find(x => x.id === id) ?? unknownItem();
};
const trackById = (id: string): SpotifyTrack => TRACKS.find(t => t.uri === `spotify:track:${id}`) ?? unknownItem();

// ---- browsing ----

const TYPES = ["track", "album", "artist", "playlist"] as const;

route("GET", "/spotify/search", ({ query }) => {
  const q = (query.get("q") ?? "").trim();
  if (q.length < 1 || q.length > 100) invalid("q", "Must be between 1 and 100 characters in length.");
  const types = (query.get("type") ?? TYPES.join(",")).split(",");
  if (types.some(t => !(TYPES as readonly string[]).includes(t))) invalid("type", "Must be a list of track, album, artist, playlist.");
  const results: SpotifySearchResults = { tracks: [], albums: [], artists: [], playlists: [] };
  // A pasted link or URI is a direct lookup.
  const direct = q.match(LINK) ?? q.match(URI);
  if (direct) {
    const [, kind, id = ""] = direct;
    if (kind === "track") results.tracks = [trackById(id)];
    if (kind === "album") results.albums = [summary(byId(ALBUMS, id))];
    if (kind === "artist") results.artists = [artistSummary(byId(ARTISTS, id))];
    if (kind === "playlist") results.playlists = [playlistSummary(byId(PLAYLISTS, id))];
    return results;
  }
  // Spotify's field filters, as the desktop's Windows track lookup sends them: track:"<title>" artist:"<artist>"
  const fields = new Map([...q.matchAll(/(track|artist):"([^"]*)"/g)].map(([, field = "", value = ""]) => [field, value.trim().toLowerCase()]));
  const text = q.replace(/(track|artist):"[^"]*"/g, " ").trim().toLowerCase();
  const has = (...texts: (string | undefined)[]) => !!text && texts.some(t => t?.toLowerCase().includes(text));
  const byFields = (t: SpotifyTrack) =>
    (!fields.has("track") || t.title.toLowerCase().includes(fields.get("track")!)) && (!fields.has("artist") || t.artists.some(a => a.toLowerCase().includes(fields.get("artist")!)));
  if (types.includes("track")) results.tracks = TRACKS.filter(t => byFields(t) && (!text || has(t.title, t.album, ...t.artists))).slice(0, 10);
  if (types.includes("album")) results.albums = ALBUMS.filter(a => has(a.name, ...a.artists)).map(summary);
  if (types.includes("artist")) results.artists = ARTISTS.filter(a => has(a.name)).map(artistSummary);
  if (types.includes("playlist")) results.playlists = PLAYLISTS.filter(p => has(p.name, ...p.tracks.flatMap(t => t.artists))).map(playlistSummary);
  return results;
});

route("GET", "/spotify/albums/([^/]+)", ({ params }) => structuredClone(byId(ALBUMS, params[0])));
route("GET", "/spotify/playlists/([^/]+)", ({ params }) => structuredClone(byId(PLAYLISTS, params[0])));
route("GET", "/spotify/artists/([^/]+)", ({ params }) => structuredClone(byId(ARTISTS, params[0])));
route("GET", "/spotify/tracks/([^/]+)", ({ params }) => {
  if (!SPOTIFY_ID.test(params[0] ?? "")) invalid("id", "Not a Spotify id.");
  return { ...trackById(params[0] ?? "") };
});

// ---- the one session ----

interface Session {
  channelId: string;
  state: SpotifyState;
  history: SpotifyTrack[];
}
let session: Session | null = null;
let botTimer: ReturnType<typeof setTimeout> | undefined;
let endTimer: ReturnType<typeof setTimeout> | undefined;
let qidCounter = 0;

const copy = (state: SpotifyState, full = false): SpotifyState => ({
  ...state,
  track: state.track && { ...state.track, artists: [...state.track.artists] },
  queue: (full ? state.queue : state.queue.slice(0, SPOTIFY_EVENT_QUEUE_MAX)).map(q => ({ ...q, artists: [...q.artists] })),
});

export const spotifyOf = (channelId: string): SpotifyState | undefined => (session?.channelId === channelId ? copy(session.state) : undefined);

/** The session if it is in one of the guild's voice channels `viewerId` can see (READY / GUILD_CREATE). */
export function spotifyFor(guildId: string, viewerId: string): SpotifyUpdate[] {
  const channel = session && db.channels.get(session.channelId);
  return session && channel && channel.guild_id === guildId && canView(channel, viewerId) ? [{ channel_id: channel.id, state: copy(session.state) }] : [];
}

function announce(channel: MockChannel, state: SpotifyState | null): void {
  emit(voiceAudience(channel), "SPOTIFY_UPDATE", { channel_id: channel.id, state: state && copy(state) });
}

function connectedChannel(viewerId: string, channelId: string): MockChannel {
  const channel = requireChannel(channelId, viewerId);
  if (channel.type === ChannelType.GuildStage) fail(400, 50024, "Cannot execute action on this channel type");
  if (voiceStates.get(viewerId)?.channel_id !== channel.id) fail(403, 50013, MISSING_PERMISSIONS);
  return channel;
}

const here = (s: SpotifyState, now: number) => (s.playing && s.status === "playing" ? s.position_ms + Math.max(0, now - s.updated_at_ms) : s.position_ms);

/** Re-arms the stand-in bot: start the track after a beat, end it when its time is up. */
function botFollows(channel: MockChannel): void {
  clearTimeout(botTimer);
  clearTimeout(endTimer);
  const state = session?.state;
  if (!state?.track) return;
  if (state.status === "starting" || state.status === "loading") {
    botTimer = setTimeout(() => {
      if (!session || session.state !== state) return;
      session.state = { ...state, status: state.playing ? "playing" : "paused", updated_at_ms: Date.now() };
      announce(channel, session.state);
      botFollows(channel);
    }, botStartMs);
    return;
  }
  if (state.status === "playing" && state.playing) {
    endTimer = setTimeout(() => {
      if (!session || session.state !== state) return;
      session.state = advance(session, Date.now(), true);
      announce(channel, session.state);
      botFollows(channel);
    }, Math.max(0, state.track.duration_ms - here(state, Date.now())));
  }
}

/** Plays `next` (or nothing) now; the current track goes to the history. */
function playNow(s: Session, next: SpotifyTrack | null, now: number): SpotifyState {
  if (s.state.track) s.history = [...s.history, s.state.track].slice(-20);
  return { ...s.state, track: next, status: next ? "loading" : "paused", playing: !!next, position_ms: 0, updated_at_ms: now, can_previous: true };
}

/** The track ended (`natural`) or was skipped: the loop mode decides what follows. */
function advance(s: Session, now: number, natural: boolean): SpotifyState {
  const state = s.state;
  if (natural && state.loop === "track" && state.track) return { ...state, position_ms: 0, updated_at_ms: now };
  const queue = [...state.queue];
  if (state.loop === "queue" && state.track) queue.push(entry(state.track, state.started_by));
  const [first, ...rest] = queue;
  const next = playNow(s, first ? strip(first) : null, now);
  return withQueue(next, rest);
}

const strip = ({ qid: _q, added_by: _a, ...t }: SpotifyQueueEntry): SpotifyTrack => t;
function entry(t: SpotifyTrack, by: string): SpotifyQueueEntry {
  qidCounter += 1;
  return { ...t, artists: [...t.artists], qid: `q${qidCounter}${Math.random().toString(36).slice(2, 8)}`, added_by: by };
}
const withQueue = (state: SpotifyState, queue: SpotifyQueueEntry[]): SpotifyState => ({ ...state, queue, queue_len: queue.length });

/** The tracks behind a URI: [first, ...rest] for an album or playlist, [track] for a track. */
function tracksOf(uri: unknown, field: string, allowArtist = false): SpotifyTrack[] {
  const match = typeof uri === "string" ? uri.match(URI) : null;
  if (!match || (match[1] === "artist" && !allowArtist)) return invalid(field, "Must be a track, album or playlist URI.");
  const [, kind, id = ""] = match;
  if (kind === "track") return [trackById(id)];
  if (kind === "album") return byId(ALBUMS, id).tracks;
  if (kind === "playlist") return byId(PLAYLISTS, id).tracks;
  return invalid(field, "Must be a track, album or playlist URI.");
}

function refuseConflicts(channel: MockChannel, viewerId: string): void {
  if (stremioOf(channel.id)) fail(409, 40034, "Another media activity is running in this channel. Stop the movie first.");
  if (!session || session.channelId === channel.id) return;
  const other = db.channels.get(session.channelId);
  const guild = other?.guild_id ? db.guilds.get(other.guild_id) : undefined;
  const starter = db.accounts.get(session.state.started_by)?.user;
  if (other && guild && canView(other, viewerId)) {
    fail(409, 40035, `Spotify is already playing in #${other.name} on ${guild.guild.name}${starter ? ` (started by ${starter.global_name ?? starter.username})` : ""}`);
  }
  fail(409, 40035, "Spotify is already playing in another call.");
}

route("PUT", `/channels/${ID}/spotify`, ({ viewer, params, body }): SpotifyReply => {
  const channel = connectedChannel(viewer.user.id, params[0] ?? "");
  const [first, ...rest] = tracksOf(body.uri, "uri");
  if (!first) return unknownItem();
  refuseConflicts(channel, viewer.user.id);
  const now = Date.now();
  const fresh = !session;
  if (!session) {
    session = {
      channelId: channel.id,
      history: [],
      state: { status: "starting", track: null, playing: true, position_ms: 0, updated_at_ms: now, loop: "off", queue: [], queue_len: 0, can_previous: false, started_by: viewer.user.id, bot_identity: `bot:spotify:${channel.id}` },
    };
  }
  const room = SPOTIFY_QUEUE_MAX - session.state.queue.length;
  const front = rest.slice(0, Math.max(0, room)).map(t => entry(t, viewer.user.id));
  const next = withQueue(playNow(session, first, now), [...front, ...session.state.queue]);
  if (fresh) {
    next.status = "starting";
    next.can_previous = false;
  }
  session.state = next;
  announce(channel, next);
  botFollows(channel);
  const leftOut = rest.length - front.length;
  return { ...copy(next), ...(leftOut > 0 ? { left_out: leftOut } : {}) };
});

const PATCH_KEYS = ["playing", "position_ms", "skip", "previous", "loop", "shuffle", "queue_add", "queue_remove", "queue_move", "queue_clear"];

route("PATCH", `/channels/${ID}/spotify`, ({ viewer, params, body }): SpotifyReply => {
  const channel = connectedChannel(viewer.user.id, params[0] ?? "");
  const keys = Object.keys(body).filter(k => PATCH_KEYS.includes(k));
  if (keys.length !== 1) invalid("body", "Send exactly one change.");
  const s = session?.channelId === channel.id ? session : null;
  if (!s) return fail(400, 40033, "Nothing is playing in this channel.");
  const now = Date.now();
  let state = s.state;
  let leftOut = 0;
  const findQid = (qid: unknown) => {
    const index = state.queue.findIndex(q => q.qid === qid);
    if (index < 0) invalid("qid", "No such entry in the queue.");
    return index;
  };
  switch (keys[0]) {
    case "playing": {
      const playing = body.playing === true;
      state = { ...state, position_ms: here(state, now), playing, updated_at_ms: now, status: state.status === "playing" || state.status === "paused" ? (playing && state.track ? "playing" : "paused") : state.status };
      break;
    }
    case "position_ms": {
      const ms = body.position_ms;
      if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 0 || ms > (state.track?.duration_ms ?? 0)) invalid("position_ms", "Must be within the track.");
      state = { ...state, position_ms: ms as number, updated_at_ms: now };
      break;
    }
    case "skip":
      state = advance(s, now, false);
      break;
    case "previous": {
      if (state.track && here(state, now) > 3000) {
        state = { ...state, position_ms: 0, updated_at_ms: now };
        break;
      }
      const last = s.history.pop();
      if (!last) {
        state = { ...state, position_ms: 0, updated_at_ms: now };
        break;
      }
      const queue = state.track ? [entry(state.track, viewer.user.id), ...state.queue] : state.queue;
      state = withQueue({ ...state, track: last, status: "loading", playing: true, position_ms: 0, updated_at_ms: now, can_previous: s.history.length > 0 }, queue);
      break;
    }
    case "loop": {
      const loop = body.loop as SpotifyLoop;
      if (!["off", "track", "queue"].includes(loop)) invalid("loop", "Must be off, track or queue.");
      state = { ...state, loop };
      break;
    }
    case "shuffle": {
      const queue = [...state.queue];
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j] as SpotifyQueueEntry, queue[i] as SpotifyQueueEntry];
      }
      state = withQueue(state, queue);
      break;
    }
    case "queue_add": {
      const add = body.queue_add as { uri?: unknown; next?: unknown } | undefined;
      const tracks = tracksOf(add?.uri, "queue_add");
      const room = SPOTIFY_QUEUE_MAX - state.queue.length;
      if (room <= 0) invalid("queue_add", `The queue holds at most ${SPOTIFY_QUEUE_MAX} tracks.`);
      const added = tracks.slice(0, room).map(t => entry(t, viewer.user.id));
      leftOut = tracks.length - added.length;
      const queue = add?.next === true ? [...added, ...state.queue] : [...state.queue, ...added];
      // Nothing was playing (the queue ran out): the new tracks start at once.
      state = state.track ? withQueue(state, queue) : advance({ ...s, state: withQueue(state, queue) }, now, false);
      break;
    }
    case "queue_remove": {
      const queue = [...state.queue];
      queue.splice(findQid(body.queue_remove), 1);
      state = withQueue(state, queue);
      break;
    }
    case "queue_move": {
      const move = body.queue_move as { qid?: unknown; to?: unknown } | undefined;
      const from = findQid(move?.qid);
      if (typeof move?.to !== "number" || !Number.isInteger(move.to) || move.to < 0) invalid("to", "Must be an index.");
      const queue = [...state.queue];
      const [moved] = queue.splice(from, 1);
      queue.splice(Math.min(move?.to as number, queue.length), 0, moved as SpotifyQueueEntry);
      state = withQueue(state, queue);
      break;
    }
    case "queue_clear":
      state = withQueue(state, []);
      break;
  }
  s.state = state;
  announce(channel, state);
  botFollows(channel);
  return { ...copy(state), ...(leftOut > 0 ? { left_out: leftOut } : {}) };
});

route("GET", `/channels/${ID}/spotify`, ({ viewer, params }) => {
  const channel = connectedChannel(viewer.user.id, params[0] ?? "");
  if (session?.channelId !== channel.id) return fail(400, 40033, "Nothing is playing in this channel.");
  return copy(session.state, true);
});

route("DELETE", `/channels/${ID}/spotify`, ({ viewer, params }) => {
  const channel = connectedChannel(viewer.user.id, params[0] ?? "");
  endSpotify(channel.id);
  return undefined;
});

route("POST", `/channels/${ID}/spotify/listener-token`, ({ viewer, params }): SpotifyListenerToken => {
  const channel = connectedChannel(viewer.user.id, params[0] ?? "");
  if (session?.channelId !== channel.id) return fail(400, 40033, "Nothing is playing in this channel.");
  return { url: MOCK_SPOTIFY_ENDPOINT, token: `mock-listener-${channel.id}` };
});

/** The session of `channelId` ends (stop, error, or nobody is left in voice). */
export function endSpotify(channelId: string): void {
  if (session?.channelId !== channelId) return;
  clearTimeout(botTimer);
  clearTimeout(endTimer);
  session = null;
  const channel = db.channels.get(channelId);
  if (channel) announce(channel, null);
}

// Test hooks (Playwright): `fail` puts the session in error with one of the server's fixed texts; `notice` shows a passing note.
if (typeof window !== "undefined") {
  (window as unknown as { __vokkoMockSpotify: unknown }).__vokkoMockSpotify = {
    fail: (message = "Playback failed.") => {
      const channel = session && db.channels.get(session.channelId);
      if (!session || !channel) return;
      session.state = { ...session.state, status: "error", error: message, playing: false, updated_at_ms: Date.now() };
      clearTimeout(endTimer);
      announce(channel, session.state);
    },
    notice: (text = "Skipped an unavailable track") => {
      const channel = session && db.channels.get(session.channelId);
      if (!session || !channel) return;
      session.state = { ...session.state, notice: text };
      announce(channel, session.state);
    },
    botDelay: (ms: number) => {
      botStartMs = ms;
    },
    ids: { album: ALBUMS[0]?.id, playlist: PLAYLISTS[0]?.id, artist: ARTISTS[0]?.id, tracks: TRACKS.map(t => t.uri) },
  };
}
