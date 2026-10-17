// Mock games (docs/design/games-host.md sections 4 and 5): the per-guild allow-list (GET / POST / PATCH / DELETE
// /guilds/{id}/games, GUILD_GAMES_UPDATE), one session per call (PUT / DELETE /channels/{id}/game, GAME_UPDATE), the player
// list with app ids, and the relay (POST /channels/{id}/game/messages, GAME_MESSAGE to the people in the call). The session
// ends when the last person leaves (voice.ts releaseChannel calls `endGame`). Seeded people in the call (no gateway session,
// e.g. Alice and Bob in General) play the second participant: the first of them answers {"ping":n} with {"pong":n}.
// shortcut: no relay or control rate limits here (the server has them); add them if an e2e needs the 429 path.

import { GAME_RELAY_MAX_BYTES, GUILD_GAMES_MAX, type GameAspect, type GameManifest, type GamePlayer, type GameSession, type GameUpdate } from "../types";
import { Perm, hasBit } from "../permissions";
import { BUILTIN_GAMES } from "../../games/builtin";
import { canView, channelPermsOf } from "./access";
import { db, nextId, type MockChannel } from "./db";
import { fail, MISSING_PERMISSIONS, requireChannel, requireGuildMember, requireGuildPerm } from "./ops";
import { ID, route } from "./router";
import { emit, onlineUserIds } from "./socket";
import { voiceAudience, voiceStates } from "./voice";

const ASPECTS = new Set<GameAspect>(["16:9", "4:3", "1:1", "fill"]);
/** Controls and invisible characters (zero-width, bidi, fillers) a game name or icon may not carry. */
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u001f\u007f-\u009f­؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯⠀ㅤ︀-️﻿ﾠ￹-￻]/;
/** Variation selectors and ZWJ are part of emoji, so the icon check allows them. */
// eslint-disable-next-line no-control-regex
const HIDDEN_ICON = /[\u0000-\u001f\u007f-\u009f­؜​-‌‎‏‪-‮⁠-⁯]/;

/** guildId → games, in insertion order. */
const catalogs = new Map<string, GameManifest[]>();
/** channelId → running session. */
const sessions = new Map<string, GameSession>();

const invalid = (field: string, message: string): never => fail(400, 50035, "Invalid Form Body", { [field]: { code: "INVALID", message } });

/** The design's app id is an HMAC; the mock only needs it stable per game and user and free of the user id. */
export function mockAppId(gameId: string, userId: string): string {
  const text = `${gameId}:${userId}`;
  let out = "";
  let h = 2166136261;
  for (let round = 0; out.length < 22; round += 1) {
    for (const ch of `${text}#${round}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    out += h.toString(36);
  }
  return out.slice(0, 22);
}

function copyGame(game: GameManifest): GameManifest {
  return { ...game };
}

function copySession(session: GameSession): GameSession {
  return { ...session, game: copyGame(session.game) };
}

export const gameOf = (channelId: string): GameSession | undefined => {
  const session = sessions.get(channelId);
  return session && copySession(session);
};

/** Sessions in the guild's voice channels `viewerId` can see (READY / GUILD_CREATE `games`). */
export function gamesFor(guildId: string, viewerId: string): GameUpdate[] {
  return [...sessions.entries()].flatMap(([channelId, state]) => {
    const channel = db.channels.get(channelId);
    return channel && channel.guild_id === guildId && canView(channel, viewerId) ? [{ channel_id: channelId, state: copySession(state) }] : [];
  });
}

function announce(channel: MockChannel, state: GameSession | null): void {
  emit(voiceAudience(channel), "GAME_UPDATE", { channel_id: channel.id, state: state && copySession(state) });
}

function announceCatalog(guildId: string): void {
  const guild = db.guilds.get(guildId);
  if (guild) emit(guild.members.keys(), "GUILD_GAMES_UPDATE", { guild_id: guildId });
}

/** The session of `channelId` ends (stop, its game was removed, or nobody is left in voice). */
export function endGame(channelId: string): void {
  if (!sessions.delete(channelId)) return;
  const channel = db.channels.get(channelId);
  if (channel) announce(channel, null);
}

// ---- catalog ----

function name(value: unknown): string {
  if (typeof value !== "string") return invalid("name", "Must be a string.");
  const text = value.trim();
  if (text.length === 0 || [...text].length > 32) invalid("name", "Must be between 1 and 32 in length.");
  if (HIDDEN.test(text)) invalid("name", "Must not contain control or invisible characters.");
  return text;
}

function gameUrl(value: unknown): string {
  if (typeof value !== "string") return invalid("url", "Must be a string.");
  if (new TextEncoder().encode(value).length > 512) invalid("url", "Must be 512 or fewer bytes.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid("url", "Must be an absolute https URL.");
  }
  const local = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !local) invalid("url", "Must be an absolute https URL.");
  if (url.username || url.password) invalid("url", "Must not contain a user name or password.");
  if (url.hash || value.includes("#")) invalid("url", "Must not contain a fragment.");
  if (url.origin === globalThis.location?.origin) invalid("url", "Must not be this server's own address");
  return value;
}

function icon(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return invalid("icon", "Must be one emoji.");
  const text = value.trim();
  const graphemes = typeof Intl.Segmenter === "function" ? [...new Intl.Segmenter().segment(text)].length : [...text].length;
  if (graphemes !== 1 || new TextEncoder().encode(text).length > 16 || HIDDEN_ICON.test(text) || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text)) invalid("icon", "Must be one emoji.");
  return text;
}

function players(field: string, value: unknown, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > 16) return invalid(field, `Must be between ${min} and 16.`);
  return value;
}

function aspect(value: unknown): GameAspect {
  if (value === undefined || value === null) return "16:9";
  if (typeof value !== "string" || !ASPECTS.has(value as GameAspect)) return invalid("aspect", 'Must be one of "16:9", "4:3", "1:1", "fill".');
  return value as GameAspect;
}

function manifest(id: string, body: Record<string, unknown>, base?: GameManifest): GameManifest {
  const pick = (key: keyof GameManifest) => (key in body ? body[key] : base?.[key]);
  const min = players("min_players", pick("min_players"), 1);
  const game: GameManifest = { id, name: name(pick("name")), url: gameUrl(pick("url")), min_players: min, max_players: players("max_players", pick("max_players"), min), aspect: aspect(pick("aspect")) };
  const emoji = icon(pick("icon"));
  if (emoji) game.icon = emoji;
  return game;
}

route("GET", `/guilds/${ID}/games`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  return (catalogs.get(guildId) ?? []).map(copyGame);
});

route("POST", `/guilds/${ID}/games`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  requireGuildPerm(guildId, viewer.user.id, Perm.MANAGE_GUILD);
  const list = catalogs.get(guildId) ?? [];
  if (list.length >= GUILD_GAMES_MAX) fail(400, 30090, `Maximum number of games reached (${GUILD_GAMES_MAX})`);
  const game = manifest(nextId(), body);
  catalogs.set(guildId, [...list, game]);
  announceCatalog(guildId);
  return copyGame(game);
});

route("PATCH", `/guilds/${ID}/games/${ID}`, ({ viewer, params, body }) => {
  const [guildId = "", gameId = ""] = params;
  requireGuildPerm(guildId, viewer.user.id, Perm.MANAGE_GUILD);
  const list = catalogs.get(guildId) ?? [];
  const current = list.find(g => g.id === gameId) ?? fail(404, 10090, "Unknown Game");
  const next = manifest(gameId, body, current);
  catalogs.set(guildId, list.map(g => (g.id === gameId ? next : g)));
  announceCatalog(guildId);
  return copyGame(next);
});

route("DELETE", `/guilds/${ID}/games/${ID}`, ({ viewer, params }) => {
  const [guildId = "", gameId = ""] = params;
  requireGuildPerm(guildId, viewer.user.id, Perm.MANAGE_GUILD);
  const list = catalogs.get(guildId) ?? [];
  if (!list.some(g => g.id === gameId)) fail(404, 10090, "Unknown Game");
  catalogs.set(guildId, list.filter(g => g.id !== gameId));
  for (const [channelId, session] of sessions) if (session.game.id === gameId && db.channels.get(channelId)?.guild_id === guildId) endGame(channelId);
  announceCatalog(guildId);
  return undefined;
});

// ---- session and relay ----

function connectedChannel(viewerId: string, channelId: string): MockChannel {
  const channel = requireChannel(channelId, viewerId);
  if (voiceStates.get(viewerId)?.channel_id !== channel.id) fail(403, 50013, MISSING_PERMISSIONS);
  return channel;
}

const inCall = (channelId: string): string[] => [...voiceStates.values()].filter(s => s.channel_id === channelId).map(s => s.user_id);

function running(channelId: string): GameSession {
  return sessions.get(channelId) ?? fail(404, 10091, "No game is running in this call");
}

function sessionId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, "0")).join("");
}

route("PUT", `/channels/${ID}/game`, ({ viewer, params, body }) => {
  const channel = connectedChannel(viewer.user.id, params[0] ?? "");
  const gameId = typeof body.game_id === "string" ? body.game_id : "";
  const game = BUILTIN_GAMES.find(g => g.id === gameId) ?? (channel.guild_id ? catalogs.get(channel.guild_id)?.find(g => g.id === gameId) : undefined) ?? fail(404, 10090, "Unknown Game");
  if (sessions.has(channel.id)) fail(409, 40090, "A game is already running");
  const session: GameSession = { session_id: sessionId(), game: copyGame(game), started_by: viewer.user.id, started_at_ms: Date.now() };
  sessions.set(channel.id, session);
  announce(channel, session);
  return copySession(session);
});

route("GET", `/channels/${ID}/game/players`, ({ viewer, params }) => {
  const channel = connectedChannel(viewer.user.id, params[0] ?? "");
  const session = running(channel.id);
  return inCall(channel.id).map((userId): GamePlayer => ({ user_id: userId, app_id: mockAppId(session.game.id, userId) }));
});

route("POST", `/channels/${ID}/game/messages`, ({ viewer, params, body }) => {
  const channel = connectedChannel(viewer.user.id, params[0] ?? "");
  const session = running(channel.id);
  const text = JSON.stringify(body.data);
  if (text === undefined) invalid("data", "Must be JSON.");
  if (new TextEncoder().encode(text).length > GAME_RELAY_MAX_BYTES) invalid("data", `Must be ${GAME_RELAY_MAX_BYTES} or fewer bytes.`);
  const people = inCall(channel.id);
  let recipients = people.filter(id => id !== viewer.user.id);
  if (body.to !== undefined && body.to !== null) {
    const target = people.find(id => mockAppId(session.game.id, id) === body.to);
    if (!target) invalid("to", "Not a player in this call.");
    recipients = [target as string];
  }
  const from = mockAppId(session.game.id, viewer.user.id);
  emit(recipients, "GAME_MESSAGE", { channel_id: channel.id, session_id: session.session_id, from, data: JSON.parse(text) });
  answerPing(channel.id, session, viewer.user.id, recipients, body.data);
  return undefined;
});

/** The seeded second participant: answers a ping to the sender, a moment later, through the relay. */
function answerPing(channelId: string, session: GameSession, senderId: string, recipients: string[], data: unknown): void {
  const ping = data && typeof data === "object" ? (data as Record<string, unknown>).ping : undefined;
  if (typeof ping !== "number") return;
  const online = onlineUserIds();
  const peer = recipients.find(id => !online.has(id));
  if (!peer || !online.has(senderId)) return;
  setTimeout(() => {
    if (sessions.get(channelId)?.session_id !== session.session_id || voiceStates.get(peer)?.channel_id !== channelId) return;
    emit([senderId], "GAME_MESSAGE", { channel_id: channelId, session_id: session.session_id, from: mockAppId(session.game.id, peer), data: { pong: ping } });
  }, 50);
}

/** Section 2 item 6 until bot control: the starter, MANAGE_CHANNELS on the channel in a guild, anyone in a DM call. */
function canStop(channel: MockChannel, userId: string, session: GameSession): boolean {
  return !channel.guild_id || session.started_by === userId || hasBit(channelPermsOf(channel, userId), Perm.MANAGE_CHANNELS);
}

route("DELETE", `/channels/${ID}/game`, ({ viewer, params }) => {
  const channel = connectedChannel(viewer.user.id, params[0] ?? "");
  const session = running(channel.id);
  if (!canStop(channel, viewer.user.id, session)) fail(403, 50013, MISSING_PERMISSIONS);
  endGame(channel.id);
  return undefined;
});
