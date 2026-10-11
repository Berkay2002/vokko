import { beforeEach, describe, expect, it, vi } from "vitest";

const socketEvents = vi.hoisted(() => [] as { users: string[]; t: string; d: unknown }[]);
vi.mock("./socket", () => ({ emit: (users: Iterable<string>, t: string, d: unknown) => void socketEvents.push({ users: [...users], t, d }) }));

import { ApiRequestError } from "../errors";
import { Perm } from "../permissions";
import { ChannelType, OverwriteType, type Channel, type VoiceState } from "../types";
import { db } from "./db";
import { addChannel, createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";
import { guildPayload } from "./views";
import { MOCK_VOICE_ENDPOINT, handleVoiceStateUpdate, seedVoiceState, setMockVoice, voiceStates } from "./voice";

const broadcast: { users: string[]; t: string; d: unknown }[] = [];
const direct: { session: string; t: string; d: unknown }[] = [];
const emit = (users: Iterable<string>, t: string, d: unknown) => void broadcast.push({ users: [...users], t, d });
const emitToSession = (session: string, t: string, d: unknown) => void direct.push({ session, t, d });

const ids: Record<string, string> = {};
let guildId = "";
let voiceId = "";
let secretId = "";
let tinyId = "";

const op4 = (who: string, channel: string | null, session = `gw-${who}`, extra: { self_mute?: boolean; self_deaf?: boolean } = {}) =>
  handleVoiceStateUpdate(session, ids[who]!, { guild_id: guildId, channel_id: channel, self_mute: !!extra.self_mute, self_deaf: !!extra.self_deaf, self_video: false }, emit, emitToSession);

beforeEach(() => {
  socketEvents.length = 0;
  broadcast.length = 0;
  direct.length = 0;
  voiceStates.clear();
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "plain", "other"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Voice guild");
  const guild = db.guilds.get(guildId)!;
  const joined = new Date().toISOString();
  guild.members.set(ids.plain!, { nick: null, roles: [], joined_at: joined });
  guild.members.set(ids.other!, { nick: null, roles: [], joined_at: joined });
  voiceId = [...db.channels.values()].find(c => c.guild_id === guildId && c.type === ChannelType.GuildVoice)!.id;
  secretId = addChannel(guildId, {
    name: "secret",
    type: ChannelType.GuildVoice,
    permission_overwrites: [{ id: guildId, type: OverwriteType.Role, allow: "0", deny: Perm.VIEW_CHANNEL.toString() }],
  }).id;
  tinyId = addChannel(guildId, { name: "tiny", type: ChannelType.GuildVoice, user_limit: 1 }).id;
});

describe("mock voice server (op 4)", () => {
  it("voice channels carry the default bitrate and user limit, and no status", () => {
    expect(db.channels.get(voiceId)).toMatchObject({ bitrate: 64000, user_limit: 0, status: null });
    expect(db.channels.get(tinyId)).toMatchObject({ status: null });
  });

  it("join: VOICE_SERVER_UPDATE with the mock endpoint to the requesting session, VOICE_STATE_UPDATE to the channel's audience", () => {
    op4("plain", voiceId);
    expect(direct).toHaveLength(1);
    expect(direct[0]).toMatchObject({ session: "gw-plain", t: "VOICE_SERVER_UPDATE", d: { channel_id: voiceId, endpoint: MOCK_VOICE_ENDPOINT } });
    // The token names the voice session it is for: the one the VOICE_STATE_UPDATE carries.
    expect((direct[0]!.d as { session_id: string }).session_id).toBe(voiceStates.get(ids.plain!)!.session_id);
    const update = broadcast.find(e => e.t === "VOICE_STATE_UPDATE");
    expect(update?.users.sort()).toEqual([ids.owner, ids.plain, ids.other].sort());
    expect(update?.d).toMatchObject({ user_id: ids.plain, channel_id: voiceId, self_mute: false });
    expect((update?.d as VoiceState & { member?: unknown }).member).toBeDefined();
  });

  it("a mute toggle from the same session keeps the session id and sends no new token", () => {
    op4("plain", voiceId);
    const first = voiceStates.get(ids.plain!)!.session_id;
    op4("plain", voiceId, "gw-plain", { self_mute: true });
    expect(direct).toHaveLength(1);
    expect(voiceStates.get(ids.plain!)).toMatchObject({ session_id: first, self_mute: true });
  });

  it("an unchanged op 4 from the bound session reissues the token for the same session, broadcasting nothing", () => {
    op4("plain", voiceId);
    const first = direct[0]!.d as { token: string; session_id: string };
    broadcast.length = 0;
    op4("plain", voiceId);
    expect(direct).toHaveLength(2);
    const again = direct[1]!.d as { token: string; session_id: string };
    expect(again.session_id).toBe(first.session_id);
    expect(again.token).not.toBe(first.token);
    expect(broadcast).toEqual([]);
  });

  it("joining from another gateway session is a new binding with a new session id", () => {
    op4("plain", voiceId, "gw-a");
    const first = voiceStates.get(ids.plain!)!.session_id;
    op4("plain", voiceId, "gw-b");
    expect(direct.map(d => d.session)).toEqual(["gw-a", "gw-b"]);
    expect(voiceStates.get(ids.plain!)!.session_id).not.toBe(first);
  });

  it("refuses channels the user cannot see and full channels with VOICE_CONNECT_FAILED only", () => {
    op4("plain", secretId);
    op4("other", tinyId);
    op4("plain", tinyId);
    expect(direct.map(d => [d.t, (d.d as { reason?: string }).reason])).toEqual([
      ["VOICE_CONNECT_FAILED", "missing_permissions"],
      ["VOICE_SERVER_UPDATE", undefined],
      ["VOICE_CONNECT_FAILED", "channel_full"],
    ]);
    expect(voiceStates.get(ids.plain!)).toBeUndefined();
  });

  it("the owner (MOVE_MEMBERS) bypasses the user limit", () => {
    op4("other", tinyId);
    op4("owner", tinyId);
    expect(voiceStates.get(ids.owner!)?.channel_id).toBe(tinyId);
  });

  it("leave broadcasts channel_id null and drops the state", () => {
    op4("plain", voiceId);
    broadcast.length = 0;
    op4("plain", null);
    expect(voiceStates.has(ids.plain!)).toBe(false);
    expect(broadcast[0]).toMatchObject({ t: "VOICE_STATE_UPDATE", d: { user_id: ids.plain, channel_id: null } });
  });

  it("GUILD_CREATE / READY carry only the voice states of channels the viewer can see", () => {
    seedVoiceState(ids.owner!, secretId, 1);
    seedVoiceState(ids.other!, voiceId, 1);
    expect(guildPayload(guildId, ids.plain!).voice_states?.map(s => s.user_id)).toEqual([ids.other]);
    expect(guildPayload(guildId, ids.owner!).voice_states?.map(s => s.user_id).sort()).toEqual([ids.owner, ids.other].sort());
  });
});

describe("mock voice channel status (PUT /channels/{id}/voice-status)", () => {
  const call = (who: string, channelId: string, status: unknown) => handleRoute("PUT", `/channels/${channelId}/voice-status`, { status }, ids[who] ?? null);
  const errorOf = (fn: () => unknown): { status: number; code: number } => {
    try {
      fn();
    } catch (e) {
      if (e instanceof ApiRequestError) return { status: e.status, code: e.code };
      throw e;
    }
    throw new Error("expected the call to fail");
  };
  const statusEvents = () => [...socketEvents, ...broadcast].filter(e => e.t === "VOICE_CHANNEL_STATUS_UPDATE");
  const grant = (...perms: bigint[]) => {
    const guild = db.guilds.get(guildId)!;
    const everyone = guild.guild.roles.find(r => r.id === guildId)!;
    everyone.permissions = (BigInt(everyone.permissions) | perms.reduce((a, b) => a | b, 0n)).toString();
  };

  it("MANAGE_CHANNELS sets it any time; the event goes to the channel's viewers; empty clears", () => {
    expect(call("owner", voiceId, "  Raid night  ")).toBeUndefined();
    expect(db.channels.get(voiceId)?.status).toBe("Raid night");
    const [event] = statusEvents();
    expect(event?.d).toEqual({ id: voiceId, guild_id: guildId, status: "Raid night" });
    expect(event?.users.sort()).toEqual([ids.owner, ids.plain, ids.other].sort());
    call("owner", voiceId, "");
    expect(db.channels.get(voiceId)?.status).toBeNull();
    expect(statusEvents().at(-1)?.d).toMatchObject({ status: null });
    // Hidden channel: only those who can see it hear about it.
    call("owner", secretId, "Secret plans");
    expect(statusEvents().at(-1)?.users).toEqual([ids.owner]);
  });

  it("SET_VOICE_CHANNEL_STATUS works only while connected to that channel; nothing at all is 403 50013", () => {
    expect(errorOf(() => call("plain", voiceId, "hi"))).toEqual({ status: 403, code: 50013 });
    grant(Perm.SET_VOICE_CHANNEL_STATUS);
    expect(errorOf(() => call("plain", voiceId, "hi"))).toEqual({ status: 403, code: 50013 });
    op4("plain", voiceId);
    call("plain", voiceId, "hi");
    expect(db.channels.get(voiceId)?.status).toBe("hi");
    expect(errorOf(() => call("plain", tinyId, "elsewhere"))).toEqual({ status: 403, code: 50013 });
  });

  it("400 50035 for more than 500 characters or a non-voice channel", () => {
    expect(errorOf(() => call("owner", voiceId, "x".repeat(501)))).toEqual({ status: 400, code: 50035 });
    call("owner", voiceId, "x".repeat(500));
    const text = [...db.channels.values()].find(c => c.guild_id === guildId && c.type === ChannelType.GuildText)!;
    expect(errorOf(() => call("owner", text.id, "nope"))).toEqual({ status: 400, code: 50035 });
  });

  it("is cleared (event with null) when the last person leaves the channel", () => {
    op4("plain", voiceId);
    setMockVoice(ids.other!, voiceId, emit);
    call("owner", voiceId, "Movie night");
    op4("plain", null);
    expect(db.channels.get(voiceId)?.status).toBe("Movie night"); // someone is still inside
    setMockVoice(ids.other!, tinyId, emit); // the last one moves away
    expect(db.channels.get(voiceId)?.status).toBeNull();
    expect(statusEvents().at(-1)?.d).toEqual({ id: voiceId, guild_id: guildId, status: null });
  });

  it("READY / GUILD_CREATE channels carry the status", () => {
    call("owner", voiceId, "Raid night");
    const channel = guildPayload(guildId, ids.plain!).channels.find((c: Channel) => c.id === voiceId);
    expect(channel?.status).toBe("Raid night");
  });
});
