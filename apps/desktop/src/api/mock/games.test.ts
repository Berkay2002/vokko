import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => [] as { to: string[] | string; t: string; d: unknown }[]);
const online = vi.hoisted(() => new Set<string>());
vi.mock("./socket", () => ({
  emit: (users: Iterable<string>, t: string, d: unknown) => void events.push({ to: [...users], t, d }),
  emitToSession: (session: string, t: string, d: unknown) => void events.push({ to: session, t, d }),
  onlineUserIds: () => online,
}));

import { ChannelType, type GameManifest, type GamePlayer, type GameSession } from "../types";
import { db } from "./db";
import { gameOf, mockAppId } from "./games";
import { createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";
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
const errorOf = (fn: () => unknown): { status: number; code: number; errors?: Record<string, unknown> } | null => {
  try {
    fn();
    return null;
  } catch (error) {
    const e = error as { status: number; api: { code: number; errors?: Record<string, unknown> } };
    return { status: e.status, code: e.api.code, errors: e.api.errors };
  }
};
const game = () => `/channels/${voiceId}/game`;
const catalog = () => `/guilds/${guildId}/games`;
const valid = { name: "Codenames", url: "https://play.example/vokko/", icon: "🕵️", min_players: 2, max_players: 8 };

beforeEach(() => {
  events.length = 0;
  online.clear();
  voiceStates.clear();
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "plain", "peer"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Games guild");
  const guild = db.guilds.get(guildId)!;
  const joined = new Date().toISOString();
  guild.members.set(ids.plain!, { nick: null, roles: [], joined_at: joined });
  guild.members.set(ids.peer!, { nick: null, roles: [], joined_at: joined });
  voiceId = [...db.channels.values()].find(c => c.guild_id === guildId && c.type === ChannelType.GuildVoice)!.id;
});

describe("mock games catalog", () => {
  it("lets MANAGE_GUILD add, edit and remove games, members read them", () => {
    expect(errorOf(() => call("plain", "POST", catalog(), valid))).toEqual(expect.objectContaining({ status: 403 }));
    const added = call("owner", "POST", catalog(), valid) as GameManifest;
    expect(added).toEqual(expect.objectContaining({ name: "Codenames", aspect: "16:9", icon: "🕵️" }));
    expect(call("plain", "GET", catalog())).toEqual([added]);
    const edited = call("owner", "PATCH", `${catalog()}/${added.id}`, { name: "Spies", aspect: "fill" }) as GameManifest;
    expect(edited).toEqual({ ...added, name: "Spies", aspect: "fill" });
    expect(events.filter(e => e.t === "GUILD_GAMES_UPDATE")).toHaveLength(2);
    call("owner", "DELETE", `${catalog()}/${added.id}`);
    expect(call("plain", "GET", catalog())).toEqual([]);
  });

  it("validates the manifest", () => {
    const bad = (body: Record<string, unknown>) => Object.keys(errorOf(() => call("owner", "POST", catalog(), { ...valid, ...body }))?.errors ?? {});
    expect(bad({ url: "http://play.example/" })).toEqual(["url"]);
    expect(bad({ url: "https://u:p@play.example/" })).toEqual(["url"]);
    expect(bad({ url: "https://play.example/#x" })).toEqual(["url"]);
    expect(bad({ url: `https://play.example/${"a".repeat(500)}` })).toEqual(["url"]);
    expect(bad({ name: "evil‮exe" })).toEqual(["name"]);
    expect(bad({ name: "" })).toEqual(["name"]);
    expect(bad({ icon: "ab" })).toEqual(["icon"]);
    expect(bad({ min_players: 0 })).toEqual(["min_players"]);
    expect(bad({ max_players: 1 })).toEqual(["max_players"]);
    expect(bad({ aspect: "21:9" })).toEqual(["aspect"]);
  });
});

describe("mock game session and relay", () => {
  it("starts in voice only, one at a time, and lists players with app ids", () => {
    expect(errorOf(() => call("plain", "PUT", game(), { game_id: "builtin:sketch" }))?.status).toBe(403);
    op4("plain", voiceId);
    op4("peer", voiceId);
    expect(errorOf(() => call("plain", "PUT", game(), { game_id: "builtin:nope" }))).toEqual(expect.objectContaining({ status: 404, code: 10090 }));
    const session = call("plain", "PUT", game(), { game_id: "builtin:sketch" }) as GameSession;
    expect(session.session_id).toMatch(/^[0-9a-f]{16}$/);
    expect(errorOf(() => call("peer", "PUT", game(), { game_id: "builtin:sketch" }))).toEqual(expect.objectContaining({ status: 409, code: 40090 }));
    expect(events.find(e => e.t === "GAME_UPDATE")?.d).toEqual({ channel_id: voiceId, state: session });
    expect(guildPayload(guildId, ids.owner!).games).toEqual([{ channel_id: voiceId, state: session }]);
    const players = call("plain", "GET", `${game()}/players`) as GamePlayer[];
    expect(players.map(p => p.user_id).sort()).toEqual([ids.plain, ids.peer].sort());
    for (const p of players) {
      expect(p.app_id).toHaveLength(22);
      expect(p.app_id).not.toContain(p.user_id);
      expect(p.app_id).toBe(mockAppId("builtin:sketch", p.user_id));
    }
    expect(mockAppId("builtin:sketch", ids.plain!)).not.toBe(mockAppId("builtin:mock", ids.plain!));
  });

  it("relays to the call but not the sender, to one player with `to`, refuses big data, and the seeded peer answers pings", async () => {
    op4("plain", voiceId);
    op4("peer", voiceId);
    online.add(ids.plain!);
    const session = call("plain", "PUT", game(), { game_id: "builtin:mock" }) as GameSession;
    events.length = 0;
    call("plain", "POST", `${game()}/messages`, { data: { ping: 3 } });
    const relayed = events.filter(e => e.t === "GAME_MESSAGE");
    expect(relayed).toEqual([{ to: [ids.peer], t: "GAME_MESSAGE", d: { channel_id: voiceId, session_id: session.session_id, from: mockAppId("builtin:mock", ids.plain!), data: { ping: 3 } } }]);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(events.filter(e => e.t === "GAME_MESSAGE").at(-1)).toEqual({ to: [ids.plain], t: "GAME_MESSAGE", d: { channel_id: voiceId, session_id: session.session_id, from: mockAppId("builtin:mock", ids.peer!), data: { pong: 3 } } });

    events.length = 0;
    call("peer", "POST", `${game()}/messages`, { data: "hi", to: mockAppId("builtin:mock", ids.plain!) });
    expect(events.filter(e => e.t === "GAME_MESSAGE").map(e => e.to)).toEqual([[ids.plain]]);
    expect(errorOf(() => call("plain", "POST", `${game()}/messages`, { data: "x".repeat(4095) }))?.errors).toHaveProperty("data");
    expect(errorOf(() => call("plain", "POST", `${game()}/messages`, { data: 1, to: "nobody" }))?.errors).toHaveProperty("to");
  });

  it("stops by the starter or MANAGE_CHANNELS, and ends with the last leave", () => {
    op4("plain", voiceId);
    op4("peer", voiceId);
    op4("owner", voiceId);
    call("plain", "PUT", game(), { game_id: "builtin:sketch" });
    expect(errorOf(() => call("peer", "DELETE", game()))?.status).toBe(403);
    call("owner", "DELETE", game());
    expect(gameOf(voiceId)).toBeUndefined();
    expect(errorOf(() => call("plain", "GET", `${game()}/players`))).toEqual(expect.objectContaining({ status: 404, code: 10091 }));

    call("peer", "PUT", game(), { game_id: "builtin:sketch" });
    op4("plain", null);
    op4("owner", null);
    expect(gameOf(voiceId)).toBeDefined();
    op4("peer", null);
    expect(gameOf(voiceId)).toBeUndefined();
    expect(events.filter(e => e.t === "GAME_UPDATE").at(-1)?.d).toEqual({ channel_id: voiceId, state: null });
  });
});
