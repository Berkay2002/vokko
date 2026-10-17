// Mock Stremio in calls (docs/design/stremio-bot.md sections 3 and 12): account linking, Cinemeta-style browsing, stream lists,
// PUT / PATCH / DELETE /channels/{id}/stremio, the viewer token and STREMIO_UPDATE, in memory per channel like the server.
// There is no Stremio, TorBox or bot here: a stand-in bot moves a new session from "starting" to "playing" after a short delay.
// A user has to link first (Alice and Bob are linked from the start; the signed-in user links through the panel, and
// `window.__vokkoMockStremio.approve()` plays the part of approving the link in the browser).

import {
  STREMIO_IMAGE_HOSTS,
  STREMIO_POSITION_MAX_MS,
  STREMIO_QUEUE_MAX,
  type StremioAddonSubtitles,
  type StremioContinueItem,
  type StremioCues,
  type StremioItem,
  type StremioMeta,
  type StremioPatchRequest,
  type StremioSearchItem,
  type StremioState,
  type StremioStream,
  type StremioUpdate,
  type StremioViewerToken,
} from "../types";
import { receiveCue, subtitleTopic } from "../../stremio/subtitles";
import { canView } from "./access";
import { db, type MockChannel } from "./db";
import { fail, MISSING_PERMISSIONS, requireChannel } from "./ops";
import { ID, route, str } from "./router";
import { emit } from "./socket";
import { voiceAudience, voiceStates } from "./voice";

export const MOCK_STREMIO_ENDPOINT = "mock://stremio";
/** The stand-in bot reports "playing" this long after a session or an item starts (a test can stretch it to look at the starting tile). */
let botStartMs = 400;
const IMDB_ID = /^tt\d{1,10}$/;
const VIDEO_ID = /^tt\d{1,10}(:\d{1,4}:\d{1,4})?$/;

const invalid = (field: string, message: string): never => fail(400, 50035, "Invalid Form Body", { [field]: { code: "INVALID", message } });

// ---- the catalog (what Cinemeta would answer) ----

const poster = (id: string): string => `https://images.metahub.space/poster/small/${id}/img`;
const TITLES: StremioMeta[] = [
  { id: "tt0113277", type: "movie", name: "Heat", year: "1995", runtime: "170 min", poster: poster("tt0113277"), background: "https://images.metahub.space/background/medium/tt0113277/img", description: "A group of professional bank robbers start to feel the heat from police when they unknowingly leave a clue at their latest heist.", videos: [] },
  { id: "tt1375666", type: "movie", name: "Inception", year: "2010", runtime: "148 min", poster: poster("tt1375666"), description: "A thief who steals corporate secrets through dream-sharing technology is given the inverse task of planting an idea.", videos: [] },
  { id: "tt0133093", type: "movie", name: "The Matrix", year: "1999", runtime: "136 min", poster: poster("tt0133093"), description: "A computer hacker learns about the true nature of reality and his role in the war against its controllers.", videos: [] },
  {
    id: "tt0903747",
    type: "series",
    name: "Breaking Bad",
    year: "2008",
    runtime: "49 min",
    poster: poster("tt0903747"),
    background: "https://images.metahub.space/background/medium/tt0903747/img",
    description: "A chemistry teacher diagnosed with cancer turns to manufacturing methamphetamine to secure his family's future.",
    videos: [
      [1, 1, "Pilot"],
      [1, 2, "Cat's in the Bag..."],
      [1, 3, "...And the Bag's in the River"],
      [2, 1, "Seven Thirty-Seven"],
      [2, 2, "Grilled"],
    ].map(([season, episode, name]) => ({ id: `tt0903747:${season}:${episode}`, season: season as number, episode: episode as number, name: name as string, released: `2008-0${season}-1${episode}`, thumbnail: `https://episodes.metahub.space/tt0903747/${season}/${episode}/w780.jpg` })),
  },
  { id: "tt0944947", type: "series", name: "Game of Thrones", year: "2011", runtime: "57 min", poster: poster("tt0944947"), description: "Nine noble families fight for control over the lands of Westeros.", videos: [{ id: "tt0944947:1:1", season: 1, episode: 1, name: "Winter Is Coming" }, { id: "tt0944947:1:2", season: 1, episode: 2, name: "The Kingsroad" }] },
];

const searchItem = (m: StremioMeta): StremioSearchItem => ({ id: m.id, type: m.type, name: m.name, ...(m.poster ? { poster: m.poster } : {}), ...(m.year ? { year: m.year } : {}) });

// ---- accounts ----

const linked = new Map<string, string>(); // user id → linked_at
const pending = new Map<string, { code: string; approved: boolean }>(); // user id → their open link code
let codeCounter = 0;

let seeded = false;
function seedLinks(): void {
  if (seeded) return;
  seeded = true;
  for (const account of db.accounts.values()) if (["alice", "bob"].includes(account.user.username)) linked.set(account.user.id, new Date().toISOString());
}

const requireLinked = (userId: string): void => {
  seedLinks();
  if (!linked.has(userId)) fail(403, 50013, MISSING_PERMISSIONS);
};

route("GET", "/users/@me/stremio", ({ viewer }) => {
  seedLinks();
  const at = linked.get(viewer.user.id);
  return at ? { linked: true, linked_at: at } : { linked: false };
});

route("POST", "/users/@me/stremio/link", ({ viewer }) => {
  codeCounter += 1;
  const code = `K7Q${"XYZW"[codeCounter % 4]}`;
  pending.set(viewer.user.id, { code, approved: false });
  return { code, link: `https://link.stremio.com/${code}`, expires_at: new Date(Date.now() + 5 * 60_000).toISOString() };
});

route("POST", "/users/@me/stremio/link/poll", ({ viewer }) => {
  const open = pending.get(viewer.user.id);
  if (!open) return fail(400, 40033, "No link is waiting. Start again.");
  if (open.approved) {
    pending.delete(viewer.user.id);
    linked.set(viewer.user.id, new Date().toISOString());
  }
  return { linked: linked.has(viewer.user.id) };
});

route("POST", "/users/@me/stremio/login", ({ viewer, body }) => {
  const email = (str(body.email) ?? "").trim();
  const password = str(body.password) ?? "";
  if (!email.includes("@")) invalid("email", "Enter a valid email address.");
  if (!password) invalid("password", "Enter your password.");
  if (password === "wrong") return fail(400, 50035, "Invalid Form Body", { password: { code: "INVALID", message: "Stremio did not accept that email and password." } });
  linked.set(viewer.user.id, new Date().toISOString());
  return undefined;
});

route("DELETE", "/users/@me/stremio", ({ viewer }) => {
  linked.delete(viewer.user.id);
  pending.delete(viewer.user.id);
  // What this user queued goes with the account; what is playing continues.
  for (const [channelId, state] of sessions) {
    const queue = state.queue.filter(q => q.added_by !== viewer.user.id);
    if (queue.length === state.queue.length) continue;
    const next = { ...state, queue };
    sessions.set(channelId, next);
    const channel = db.channels.get(channelId);
    if (channel) announce(channel, next);
  }
  return undefined;
});

// ---- browsing ----

const type = (value: string | null): "movie" | "series" => (value === "movie" || value === "series" ? value : invalid("type", "Must be movie or series."));

route("GET", "/stremio/search", ({ query }) => {
  const kind = type(query.get("type"));
  const q = (query.get("q") ?? "").trim();
  if (q.length < 1 || q.length > 100) invalid("q", "Must be between 1 and 100 characters in length.");
  return TITLES.filter(m => m.type === kind && m.name.toLowerCase().includes(q.toLowerCase())).map(searchItem);
});

route("GET", "/stremio/catalog", ({ query }) => TITLES.filter(m => m.type === type(query.get("type"))).map(searchItem));

route("GET", `/stremio/meta/(movie|series)/(tt\\d+)`, ({ params }) => {
  const [kind, id] = params;
  const meta = TITLES.find(m => m.id === id && m.type === kind);
  if (!meta || !IMDB_ID.test(id ?? "")) return fail(404, 10003, "Unknown Title");
  return { ...meta, videos: meta.videos.map(v => ({ ...v })) };
});

// ---- continue watching (the caller's own library; every linked user starts with the same three) ----

const SERIES_MS = 3_000_000;
const MOVIE_MS = 7_200_000;
const libraries = new Map<string, StremioContinueItem[]>();

function continueOf(userId: string): StremioContinueItem[] {
  const own = libraries.get(userId);
  if (own) return own;
  const item = (id: string, videoId: string | null, position_ms: number, duration_ms: number): StremioContinueItem => {
    const meta = TITLES.find(m => m.id === id)!;
    const video = meta.videos.find(v => v.id === videoId);
    return { id, type: meta.type, name: meta.name, ...(meta.poster ? { poster: meta.poster } : {}), ...(video ? { video_id: video.id, season: video.season, episode: video.episode } : {}), position_ms, duration_ms };
  };
  // Newest first: half way into an episode, half way into a film, and an episode past its credits (the next one is offered).
  const seeded = [item("tt0903747", "tt0903747:1:2", SERIES_MS / 2, SERIES_MS), item("tt0113277", null, MOVIE_MS / 2, MOVIE_MS), item("tt0944947", "tt0944947:1:1", 2_850_000, SERIES_MS)];
  libraries.set(userId, seeded);
  return seeded;
}

route("GET", "/stremio/continue", ({ viewer }) => {
  requireLinked(viewer.user.id);
  return continueOf(viewer.user.id).map(i => ({ ...i }));
});

// ---- streams ----

interface Candidate {
  userId: string;
  item: StremioItem;
  duration_ms: number;
}
const streams = new Map<string, Candidate>();
let sidCounter = 0;

function listStreams(userId: string, kind: string, videoId: string): StremioStream[] {
  const id = videoId.split(":")[0] ?? "";
  const meta = TITLES.find(m => m.id === id && m.type === kind);
  if (!meta) return [];
  const video = meta.videos.find(v => v.id === videoId);
  const subtitle = video ? `S${video.season}E${video.episode}${video.name ? ` ${video.name}` : ""}` : undefined;
  const rows: Omit<StremioStream, "sid">[] = [
    // Ranked like the server does (section 4.3): the plain 1080p first, the heavy 4K REMUX after it.
    { addon: "Torrentio TB", label: "1080p WEB-DL", details: "Heat.1995.1080p.WEB-DL.DDP5.1.H264\n6.1 GB", size_bytes: 6_100_000_000, resolution: 1080, flags: [], playable: true },
    { addon: "Torrentio TB", label: "4K HDR REMUX", details: "Heat.1995.2160p.UHD.BluRay.REMUX.HDR.HEVC\n22.4 GB", size_bytes: 22_400_000_000, resolution: 2160, flags: ["hdr", "remux"], playable: true },
    { addon: "Torrentio TB", label: "720p BluRay", details: "Heat.1995.720p.BluRay.x264\n3.2 GB", size_bytes: 3_200_000_000, resolution: 720, flags: [], playable: true },
    { addon: "ThePirateBay+", label: "1080p", details: "Torrent only, no debrid link", resolution: 1080, flags: [], playable: false, unsupported: "torrent" },
    { addon: "YouTube", label: "Trailer", details: "Official trailer", flags: [], playable: false, unsupported: "youtube" },
  ];
  return rows.map(row => {
    sidCounter += 1;
    const sid = `sid-${sidCounter}-${Math.random().toString(36).slice(2, 10)}`;
    const item: StremioItem = { title: meta.name, ...(subtitle ? { subtitle } : {}), ...(meta.poster ? { poster: meta.poster } : {}), label: row.label };
    streams.set(sid, { userId, item, duration_ms: meta.type === "movie" ? MOVIE_MS : SERIES_MS });
    return { sid, ...row };
  });
}

route("GET", `/stremio/streams/(movie|series)/(tt[\\d:]+)`, ({ viewer, params }) => {
  requireLinked(viewer.user.id);
  const [kind, videoId] = params;
  if (!VIDEO_ID.test(videoId ?? "")) invalid("video_id", "Must look like tt0903747 or tt0903747:1:2.");
  const episodic = (videoId ?? "").includes(":");
  if ((kind === "series") !== episodic) invalid("video_id", "A series needs an episode, a movie does not have one.");
  return { streams: listStreams(viewer.user.id, kind ?? "", videoId ?? ""), addon_errors: ["TorBox"] };
});

// ---- sessions ----

const sessions = new Map<string, StremioState>();
const durations = new Map<string, number>();
const botTimers = new Map<string, ReturnType<typeof setTimeout>>();

const copy = (state: StremioState): StremioState => ({ ...state, item: { ...state.item }, queue: state.queue.map(q => ({ ...q })) });

export const stremioOf = (channelId: string): StremioState | undefined => sessions.get(channelId);

/** Sessions in the guild's voice channels `viewerId` can see (READY / GUILD_CREATE). */
export function stremioFor(guildId: string, viewerId: string): StremioUpdate[] {
  return [...sessions.entries()].flatMap(([channelId, state]) => {
    const channel = db.channels.get(channelId);
    return channel && channel.guild_id === guildId && canView(channel, viewerId) ? [{ channel_id: channelId, state: copy(state) }] : [];
  });
}

function announce(channel: MockChannel, state: StremioState | null): void {
  emit(voiceAudience(channel), "STREMIO_UPDATE", { channel_id: channel.id, state: state && copy(state) });
}

function connectedChannel(viewerId: string, channelId: string): MockChannel {
  const channel = requireChannel(channelId, viewerId);
  if (voiceStates.get(viewerId)?.channel_id !== channel.id) fail(403, 50013, MISSING_PERMISSIONS);
  return channel;
}

/** The stand-in bot connects and starts the picture a moment after the server asks for it. */
function botStarts(channel: MockChannel): void {
  clearTimeout(botTimers.get(channel.id));
  botTimers.set(
    channel.id,
    setTimeout(() => {
      const state = sessions.get(channel.id);
      if (!state || state.status !== "starting") return;
      const next = { ...state, status: "playing" as const, duration_ms: durations.get(channel.id) ?? 7_200_000, updated_at_ms: Date.now(), ...FILE_TRACKS };
      sessions.set(channel.id, next);
      announce(channel, next);
      sendCues(channel.id);
    }, botStartMs),
  );
}

// ---- tracks of the file (what the bot's ffprobe would report) ----

const FILE_TRACKS: Pick<StremioState, "audio_tracks" | "audio" | "subtitle_tracks"> = {
  audio_tracks: [
    { id: 1, language: "eng", title: "Surround", codec: "eac3", default: true },
    { id: 2, language: "swe", codec: "aac", default: false },
    { id: 3, language: "fre", codec: "ac3", default: false },
  ],
  audio: 1,
  subtitle_tracks: [
    { id: 4, kind: "text", language: "eng", codec: "subrip", forced: false, default: false },
    { id: 5, kind: "text", language: "swe", codec: "subrip", forced: false, default: false },
    { id: 6, kind: "bitmap", language: "eng", title: "Full", codec: "hdmv_pgs_subtitle", forced: false, default: false },
  ],
};
const ADDON_SUBTITLES = [
  { sid: "sub-fra", addon: "OpenSubtitles", language: "fre", label: "OpenSubtitles 1" },
  { sid: "sub-deu", addon: "OpenSubtitles", language: "ger", label: "OpenSubtitles 2" },
];
const cueTimers = new Map<string, ReturnType<typeof setInterval>>();

/** The stand-in bot publishes one cue every 5 s of media time per embedded text track, as the real one publishes data in the media room. */
function sendCues(channelId: string): void {
  clearInterval(cueTimers.get(channelId));
  let sent = -1;
  cueTimers.set(
    channelId,
    setInterval(() => {
      const state = sessions.get(channelId);
      if (!state?.playing || state.status !== "playing") return;
      const n = Math.floor((state.position_ms + (Date.now() - state.updated_at_ms)) / 5000);
      if (n === sent) return;
      sent = n;
      for (const track of state.subtitle_tracks ?? []) {
        if (track.kind !== "text") continue;
        const cue = { start_ms: n * 5000, end_ms: n * 5000 + 4000, text: `${track.language === "swe" ? "Svenska" : "English"} line ${n}` };
        receiveCue(state.bot_identity, subtitleTopic(track.id), new TextEncoder().encode(JSON.stringify(cue)));
      }
    }, 500),
  );
}

function candidate(userId: string, field: string, value: unknown): Candidate {
  const found = typeof value === "string" ? streams.get(value) : undefined;
  // A sid belongs to the user who listed it, and someone else's looks the same as one that never existed.
  if (!found || found.userId !== userId) return invalid(field, "Pick a stream from the list again.");
  return found;
}

function begin(channel: MockChannel, item: StremioItem, duration: number, queue: StremioState["queue"], startedBy: string, now = Date.now(), position = 0): StremioState {
  durations.set(channel.id, duration);
  const state: StremioState = { item, status: "starting", playing: true, position_ms: position, updated_at_ms: now, started_by: startedBy, bot_identity: `bot:stremio:${channel.id}`, queue };
  sessions.set(channel.id, state);
  botStarts(channel);
  return state;
}

route("PUT", `/channels/${ID}/stremio`, ({ viewer, params, body }) => {
  const channel = connectedChannel(viewer.user.id, params[0] ?? "");
  requireLinked(viewer.user.id);
  const picked = candidate(viewer.user.id, "sid", body.sid);
  const at = body.position_ms;
  if (at !== undefined && (typeof at !== "number" || !Number.isInteger(at) || at < 0 || at > STREMIO_POSITION_MAX_MS)) invalid("position_ms", `Must be between 0 and ${STREMIO_POSITION_MAX_MS}.`);
  const current = sessions.get(channel.id);
  const next = begin(channel, { ...picked.item }, picked.duration_ms, current?.queue ?? [], current?.started_by ?? viewer.user.id, Date.now(), typeof at === "number" ? at : 0);
  announce(channel, next);
  return copy(next);
});

route("PATCH", `/channels/${ID}/stremio`, ({ viewer, params, body }) => {
  const channel = connectedChannel(viewer.user.id, params[0] ?? "");
  const patch = body as StremioPatchRequest;
  const before = sessions.get(channel.id);
  if (!before) return fail(400, 40033, "Nothing is playing in this channel.");
  const limit = before.duration_ms ?? STREMIO_POSITION_MAX_MS;
  if (patch.position_ms !== undefined && (!Number.isInteger(patch.position_ms) || patch.position_ms < 0 || patch.position_ms > limit)) invalid("position_ms", `Must be between 0 and ${limit}.`);
  const added = patch.queue_add === undefined ? undefined : candidate(viewer.user.id, "queue_add", patch.queue_add);
  if (patch.queue_remove !== undefined && (!Number.isInteger(patch.queue_remove) || patch.queue_remove < 0 || patch.queue_remove >= before.queue.length)) invalid("queue_remove", "No such place in the queue.");
  const now = Date.now();
  const next = copy(before);
  const here = next.playing ? next.position_ms + Math.max(0, now - next.updated_at_ms) : next.position_ms;
  if (patch.skip === true) {
    const upNext = next.queue.shift();
    if (!upNext) {
      endStremio(channel.id);
      return null;
    }
    const item: StremioItem = { title: upNext.title, label: upNext.label, ...(upNext.subtitle ? { subtitle: upNext.subtitle } : {}), ...(upNext.poster ? { poster: upNext.poster } : {}) };
    const started = begin(channel, item, durations.get(channel.id) ?? 7_200_000, next.queue, next.started_by, now);
    announce(channel, started);
    return copy(started);
  }
  if (patch.playing !== undefined || patch.position_ms !== undefined) {
    next.position_ms = patch.position_ms ?? here;
    next.playing = patch.playing ?? next.playing;
    if (next.status === "playing" || next.status === "paused") next.status = next.playing ? "playing" : "paused";
    next.updated_at_ms = now;
  }
  if (patch.audio !== undefined) {
    if (!before.audio_tracks?.some(t => t.id === patch.audio)) invalid("audio", "No such audio track.");
    next.audio = patch.audio;
  }
  if (patch.burned_subtitle !== undefined) {
    if (patch.burned_subtitle === null) delete next.burned_subtitle;
    else if (before.subtitle_tracks?.some(t => t.id === patch.burned_subtitle && t.kind === "bitmap")) next.burned_subtitle = patch.burned_subtitle;
    else invalid("burned_subtitle", "Only a picture subtitle can be burned in.");
  }
  if (patch.queue_remove !== undefined) next.queue.splice(patch.queue_remove, 1);
  if (added) {
    if (next.queue.length >= STREMIO_QUEUE_MAX) invalid("queue_add", `The queue holds at most ${STREMIO_QUEUE_MAX} titles.`);
    next.queue.push({ ...added.item, added_by: viewer.user.id });
  }
  sessions.set(channel.id, next);
  if (JSON.stringify(next) !== JSON.stringify(before)) announce(channel, next);
  return copy(next);
});

route("DELETE", `/channels/${ID}/stremio`, ({ viewer, params }) => {
  const channel = connectedChannel(viewer.user.id, params[0] ?? "");
  endStremio(channel.id);
  return undefined;
});

route("POST", `/channels/${ID}/stremio/viewer-token`, ({ viewer, params }): StremioViewerToken => {
  const channel = connectedChannel(viewer.user.id, params[0] ?? "");
  if (!sessions.has(channel.id)) return fail(400, 40033, "Nothing is playing in this channel.");
  return { url: MOCK_STREMIO_ENDPOINT, token: `mock-viewer-${channel.id}` };
});

route("GET", `/channels/${ID}/stremio/subtitles`, ({ viewer, params }): StremioAddonSubtitles => {
  const channel = connectedChannel(viewer.user.id, params[0] ?? "");
  requireLinked(viewer.user.id);
  if (!sessions.has(channel.id)) return fail(400, 40033, "Nothing is playing in this channel.");
  return { subtitles: ADDON_SUBTITLES.map(s => ({ ...s })), addon_errors: [] };
});

route("GET", `/channels/${ID}/stremio/subtitles/([\\w-]+)`, ({ viewer, params }): StremioCues => {
  const channel = connectedChannel(viewer.user.id, params[0] ?? "");
  requireLinked(viewer.user.id);
  if (!sessions.has(channel.id)) return fail(400, 40033, "Nothing is playing in this channel.");
  const found = ADDON_SUBTITLES.find(s => s.sid === params[1]);
  if (!found) return fail(404, 10003, "Unknown Subtitle");
  const name = found.sid === "sub-fra" ? "Français" : "Deutsch";
  return { cues: Array.from({ length: 240 }, (_, n) => ({ start_ms: n * 5000, end_ms: n * 5000 + 4000, text: `${name} ${n}` })) };
});

/** The session of `channelId` ends (stop, or nobody is left in voice). */
export function endStremio(channelId: string): void {
  clearInterval(cueTimers.get(channelId));
  cueTimers.delete(channelId);
  clearTimeout(botTimers.get(channelId));
  botTimers.delete(channelId);
  durations.delete(channelId);
  if (!sessions.delete(channelId)) return;
  const channel = db.channels.get(channelId);
  if (channel) announce(channel, null);
}

// Test hooks (Playwright): `approve` is the user opening the link in a Stremio-signed-in browser; `fail` is the bot reporting an error.
if (typeof window !== "undefined") {
  (window as unknown as { __vokkoMockStremio: unknown }).__vokkoMockStremio = {
    approve: () => pending.forEach(open => (open.approved = true)),
    // The server only ever sends this generic text for an error.
    fail: (channelId: string, message = "Playback failed.") => {
      const state = sessions.get(channelId);
      const channel = db.channels.get(channelId);
      if (!state || !channel) return;
      const next = { ...state, status: "error" as const, error: message, playing: false, updated_at_ms: Date.now() };
      sessions.set(channelId, next);
      announce(channel, next);
    },
    botDelay: (ms: number) => {
      botStartMs = ms;
    },
    imageHosts: STREMIO_IMAGE_HOSTS,
  };
}
