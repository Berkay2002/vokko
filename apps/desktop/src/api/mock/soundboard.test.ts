import { beforeEach, describe, expect, it, vi } from "vitest";

const socketEvents = vi.hoisted(() => [] as { users: string[]; t: string; d: unknown }[]);
vi.mock("./socket", () => ({ emit: (users: Iterable<string>, t: string, d: unknown) => void socketEvents.push({ users: [...users], t, d }) }));

import { ApiRequestError, RateLimitedError } from "../errors";
import { Perm } from "../permissions";
import { ChannelType, OverwriteType, type Attachment } from "../types";
import { db } from "./db";
import { createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";
import { entranceSounds, noteAudioUpload, seedGuildSounds } from "./soundboard";
import { encodeWav } from "../../soundboard/helpers";
import { handleVoiceStateUpdate, voiceStates } from "./voice";

const ids: Record<string, string> = {};
let guildId = "";
let otherGuildId = "";
let voiceId = "";
let textId = "";

const call = (who: string, method: string, path: string, body?: unknown) => handleRoute(method, path, body ?? {}, ids[who]!);
const join = (who: string, channel: string | null, extra: { self_deaf?: boolean } = {}) =>
  handleVoiceStateUpdate(`gw-${who}`, ids[who]!, { guild_id: guildId, channel_id: channel, self_mute: false, self_deaf: !!extra.self_deaf, self_video: false }, () => undefined, () => undefined);

function status(fn: () => unknown): number {
  try {
    fn();
    return 200;
  } catch (e) {
    if (e instanceof ApiRequestError) return e.status;
    throw e;
  }
}

async function pendingWav(owner: string, seconds: number): Promise<string> {
  const bytes = encodeWav([new Float32Array(Math.round(8000 * seconds))], 8000, 0, seconds, 8000);
  const attachment: Attachment = { id: `${Math.random()}`.slice(2, 14), filename: "s.wav", content_type: "audio/wav", size: bytes.length, url: "blob:x", width: null, height: null };
  db.pending.set(attachment.id, { attachment, owner: ids[owner]! });
  await noteAudioUpload(attachment, new Blob([bytes as BlobPart]));
  return attachment.id;
}

const effects = () => socketEvents.filter(e => e.t === "VOICE_CHANNEL_EFFECT_SEND");

beforeEach(() => {
  socketEvents.length = 0;
  voiceStates.clear();
  entranceSounds.clear();
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.pending, db.soundboard] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "plain", "outsider"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Sound guild");
  otherGuildId = createGuildRecord(ids.owner!, "Other guild");
  const joined = new Date().toISOString();
  db.guilds.get(guildId)!.members.set(ids.plain!, { nick: null, roles: [], joined_at: joined });
  db.guilds.get(guildId)!.members.set(ids.outsider!, { nick: null, roles: [], joined_at: joined });
  db.guilds.get(otherGuildId)!.members.set(ids.plain!, { nick: null, roles: [], joined_at: joined });
  voiceId = [...db.channels.values()].find(c => c.guild_id === guildId && c.type === ChannelType.GuildVoice)!.id;
  textId = [...db.channels.values()].find(c => c.guild_id === guildId && c.type === ChannelType.GuildText)!.id;
  seedGuildSounds(otherGuildId, ids.owner!);
});

describe("mock soundboard", () => {
  it("creates, validates, edits and deletes sounds with the server's permissions and events", async () => {
    const create = async (who: string, seconds: number, extra: Record<string, unknown> = {}) => {
      const attachment_id = await pendingWav(who, seconds);
      return () => call(who, "POST", `/guilds/${guildId}/soundboard-sounds`, { name: "horn", attachment_id, emoji_name: "📯", ...extra });
    };
    // @everyone has CREATE_GUILD_EXPRESSIONS by default, like Discord.
    const created = (await create("plain", 1))() as { sound_id: string; guild_id: string; user: { id: string } };
    expect(created).toMatchObject({ guild_id: guildId, name: "horn", volume: 1, emoji_name: "📯", user: { id: ids.plain } });
    expect(socketEvents.find(e => e.t === "GUILD_SOUNDBOARD_SOUND_CREATE")?.users.sort()).toEqual([ids.owner, ids.plain, ids.outsider].sort());
    expect(status(await create("owner", 5.3))).toBe(400);
    expect(status(await create("owner", 1, { name: "x" }))).toBe(400);
    expect(status(await create("owner", 1, { volume: 2 }))).toBe(400);
    expect(status(await create("owner", 1, { emoji_name: "abc" }))).toBe(400);
    // the outsider (also a plain member) may not edit someone else's sound, the owner may
    const path = `/guilds/${guildId}/soundboard-sounds/${created.sound_id}`;
    expect(status(() => call("outsider", "PATCH", path, { name: "mine" }))).toBe(403);
    expect(call("owner", "PATCH", path, { volume: 0.3, emoji_name: null })).toMatchObject({ volume: 0.3, emoji_name: null });
    expect(call("plain", "GET", `/guilds/${guildId}/soundboard-sounds`)).toMatchObject({ items: [{ sound_id: created.sound_id }] });
    expect(status(() => call("outsider", "DELETE", path))).toBe(403);
    call("plain", "DELETE", path);
    expect(socketEvents.at(-1)).toMatchObject({ t: "GUILD_SOUNDBOARD_SOUND_DELETE", d: { sound_id: created.sound_id, guild_id: guildId } });
    expect(status(() => call("plain", "GET", path))).toBe(404);
  });

  it("plays only for the users in that voice channel, once per 3 seconds", () => {
    const send = (who: string, body: Record<string, unknown>) => () => call(who, "POST", `/channels/${voiceId}/send-soundboard-sound`, body);
    expect(status(send("plain", { sound_id: "1" }))).toBe(403); // not connected
    expect(status(() => call("plain", "POST", `/channels/${textId}/send-soundboard-sound`, { sound_id: "1" }))).toBe(400);
    join("plain", voiceId);
    join("owner", voiceId);
    send("plain", { sound_id: "1" })();
    expect(effects()).toHaveLength(1);
    expect(effects()[0]!.users.sort()).toEqual([ids.owner, ids.plain].sort());
    expect(effects()[0]!.d).toMatchObject({ channel_id: voiceId, user_id: ids.plain, sound_id: "1", source_guild_id: null });
    expect(() => send("plain", { sound_id: "2" })()).toThrow(RateLimitedError);
    // another guild's sound: plain is a member there; the outsider is not
    const external = db.soundboard.get(otherGuildId)![0]!;
    send("owner", { sound_id: external.sound_id, source_guild_id: otherGuildId })();
    expect(effects().at(-1)!.d).toMatchObject({ source_guild_id: otherGuildId, sound_url: external.url, emoji: { name: external.emoji_name } });
    join("outsider", voiceId);
    expect(status(send("outsider", { sound_id: external.sound_id, source_guild_id: otherGuildId }))).toBe(404);
    // USE_EXTERNAL_SOUNDS is needed for it
    const channel = db.channels.get(voiceId)!;
    channel.permission_overwrites = [{ id: ids.outsider!, type: OverwriteType.Member, allow: "0", deny: Perm.USE_SOUNDBOARD.toString() }];
    expect(status(send("outsider", { sound_id: "1" }))).toBe(403);
    channel.permission_overwrites = [];
    join("outsider", voiceId, { self_deaf: true });
    expect(status(send("outsider", { sound_id: "1" }))).toBe(403);
  });

  it("entrance sounds: the server's own, else the global one, for everyone in the channel on join", () => {
    expect(status(() => call("outsider", "PUT", "/users/@me/entrance-sounds", { guild_id: null, sound_id: db.soundboard.get(otherGuildId)![0]!.sound_id, source_guild_id: otherGuildId }))).toBe(404);
    call("plain", "PUT", "/users/@me/entrance-sounds", { guild_id: null, sound_id: "3" });
    const external = db.soundboard.get(otherGuildId)![1]!;
    const body = call("plain", "PUT", "/users/@me/entrance-sounds", { guild_id: guildId, sound_id: external.sound_id, source_guild_id: otherGuildId });
    expect(body).toEqual({
      entrance_sounds: [
        { guild_id: null, sound_id: "3", source_guild_id: null },
        { guild_id: guildId, sound_id: external.sound_id, source_guild_id: otherGuildId },
      ],
    });
    expect(socketEvents.at(-1)).toMatchObject({ t: "ENTRANCE_SOUNDS_UPDATE", users: [ids.plain] });
    join("owner", voiceId);
    join("plain", voiceId);
    expect(effects()).toHaveLength(1);
    expect(effects()[0]!.users.sort()).toEqual([ids.owner, ids.plain].sort());
    expect(effects()[0]!.d).toMatchObject({ user_id: ids.plain, sound_id: external.sound_id, entrance: true });
    join("plain", voiceId, { self_deaf: true }); // a toggle is not a join
    expect(effects()).toHaveLength(1);
    call("plain", "PUT", "/users/@me/entrance-sounds", { guild_id: guildId, sound_id: null });
    join("plain", null);
    join("plain", voiceId);
    expect(effects()).toHaveLength(1); // rejoining within 3 s is silent
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3100);
    try {
      join("plain", null);
      join("plain", voiceId);
      expect(effects().at(-1)!.d).toMatchObject({ sound_id: "3", entrance: true });
      expect(effects()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
