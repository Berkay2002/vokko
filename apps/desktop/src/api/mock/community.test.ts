import { beforeEach, describe, expect, it, vi } from "vitest";

const events: { users: string[]; t: string; d: unknown }[] = [];
vi.mock("./socket", () => ({
  emit: (users: Iterable<string>, t: string, d: unknown) => {
    events.push({ users: [...users], t, d });
  },
}));

import { ApiRequestError } from "../errors";
import { DEFAULT_EVERYONE, Perm } from "../permissions";
import { ChannelType, MemberFlags, OnboardingMode, RelationshipType, type FriendSuggestionsResponse, type GuildMember, type GuildOnboarding, type GuildScheduledEvent, type OnboardingCompletion } from "../types";
import { db } from "./db";
import { onboardingStartedFor } from "./community";
import { stageInstances } from "./voice";
import { addChannel, createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";
import { setRelationship } from "./views";

const ids: Record<string, string> = {};
let guildId = "";
let generalId = "";
let voiceId = "";

const call = <T = unknown>(who: string, method: string, path: string, body?: unknown): T => handleRoute(method, path, body ?? null, ids[who] ?? null) as T;
const errorOf = (fn: () => unknown): { status: number; code: number } => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiRequestError) return { status: e.status, code: e.code };
    throw e;
  }
  throw new Error("expected the call to fail");
};
const eventsOf = (t: string) => events.filter(e => e.t === t);
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const join = (who: string) => {
  const guild = db.guilds.get(guildId)!;
  const code = (call<{ code: string }>("owner", "POST", `/channels/${generalId}/invites`, {})).code;
  void guild;
  call(who, "POST", `/invites/${code}`);
};
const external = (who: string, name = "Movie night") =>
  call<GuildScheduledEvent>(who, "POST", `/guilds/${guildId}/scheduled-events`, {
    name,
    entity_type: 3,
    entity_metadata: { location: "The lounge" },
    scheduled_start_time: inHours(24),
    scheduled_end_time: inHours(26),
  });

beforeEach(() => {
  events.length = 0;
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "alice", "bob", "carl", "dana"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Test guild");
  generalId = [...db.channels.values()].find(c => c.guild_id === guildId && c.name === "general")!.id;
  voiceId = [...db.channels.values()].find(c => c.guild_id === guildId && c.name === "General" && c.type === 2)!.id;
  join("alice");
  join("bob");
  events.length = 0;
});

describe("scheduled events", () => {
  it("runs the lifecycle: create, interested, transitions, frozen when finished, delete", () => {
    const event = external("owner");
    expect(event).toMatchObject({ status: 1, entity_type: 3, user_count: 0, user_rsvp: false, privacy_level: 2, entity_metadata: { location: "The lounge" } });
    expect(eventsOf("GUILD_SCHEDULED_EVENT_CREATE")).toHaveLength(3);

    call("alice", "PUT", `/guilds/${guildId}/scheduled-events/${event.id}/users/@me`);
    call("alice", "PUT", `/guilds/${guildId}/scheduled-events/${event.id}/users/@me`);
    expect(eventsOf("GUILD_SCHEDULED_EVENT_USER_ADD")).toHaveLength(1);
    expect(call<GuildScheduledEvent>("alice", "GET", `/guilds/${guildId}/scheduled-events/${event.id}`)).toMatchObject({ user_count: 1, user_rsvp: true });
    expect(call<GuildScheduledEvent>("owner", "GET", `/guilds/${guildId}/scheduled-events/${event.id}`)).toMatchObject({ user_count: 1, user_rsvp: false });
    const users = call<{ user: { id: string }; member?: GuildMember }[]>("owner", "GET", `/guilds/${guildId}/scheduled-events/${event.id}/users?with_member=true`);
    expect(users.map(u => u.user.id)).toEqual([ids.alice]);
    expect(users[0]?.member?.user.id).toBe(ids.alice);

    expect(errorOf(() => call("owner", "PATCH", `/guilds/${guildId}/scheduled-events/${event.id}`, { status: 3 })).code).toBe(50035);
    expect(call<GuildScheduledEvent>("owner", "PATCH", `/guilds/${guildId}/scheduled-events/${event.id}`, { status: 2 }).status).toBe(2);
    expect(errorOf(() => call("owner", "PATCH", `/guilds/${guildId}/scheduled-events/${event.id}`, { entity_type: 2 })).code).toBe(50035);
    expect(call<GuildScheduledEvent>("owner", "PATCH", `/guilds/${guildId}/scheduled-events/${event.id}`, { status: 3 }).status).toBe(3);
    expect(errorOf(() => call("owner", "PATCH", `/guilds/${guildId}/scheduled-events/${event.id}`, { name: "again" }))).toEqual({ status: 400, code: 180000 });
    expect(errorOf(() => call("bob", "PUT", `/guilds/${guildId}/scheduled-events/${event.id}/users/@me`)).code).toBe(180000);
    expect(call<GuildScheduledEvent[]>("alice", "GET", `/guilds/${guildId}/scheduled-events`)).toHaveLength(0);

    call("owner", "DELETE", `/guilds/${guildId}/scheduled-events/${event.id}`);
    expect(eventsOf("GUILD_SCHEDULED_EVENT_DELETE")).toHaveLength(3);
    expect(errorOf(() => call("owner", "GET", `/guilds/${guildId}/scheduled-events/${event.id}`))).toEqual({ status: 404, code: 10065 });
  });

  it("sends a per-receiver user_rsvp and lists soonest first", () => {
    const later = external("owner", "Later");
    const sooner = call<GuildScheduledEvent>("owner", "POST", `/guilds/${guildId}/scheduled-events`, {
      name: "Sooner",
      entity_type: 2,
      channel_id: voiceId,
      scheduled_start_time: inHours(2),
    });
    call("alice", "PUT", `/guilds/${guildId}/scheduled-events/${later.id}/users/@me`);
    events.length = 0;
    call("owner", "PATCH", `/guilds/${guildId}/scheduled-events/${later.id}`, { name: "Later!" });
    const update = eventsOf("GUILD_SCHEDULED_EVENT_UPDATE");
    const rsvpOf = (userId: string) => (update.find(e => e.users.includes(userId))?.d as GuildScheduledEvent).user_rsvp;
    expect([rsvpOf(ids.alice!), rsvpOf(ids.bob!)]).toEqual([true, false]);
    expect(call<GuildScheduledEvent[]>("bob", "GET", `/guilds/${guildId}/scheduled-events`).map(e => e.id)).toEqual([sooner.id, later.id]);
  });

  it("checks CREATE_EVENTS and MANAGE_EVENTS", () => {
    const mine = external("alice", "Alice's");
    expect(call<GuildScheduledEvent>("alice", "PATCH", `/guilds/${guildId}/scheduled-events/${mine.id}`, { name: "Renamed" }).name).toBe("Renamed");
    expect(errorOf(() => call("bob", "PATCH", `/guilds/${guildId}/scheduled-events/${mine.id}`, { name: "Hijack" })).code).toBe(50013);
    expect(errorOf(() => call("bob", "DELETE", `/guilds/${guildId}/scheduled-events/${mine.id}`)).code).toBe(50013);
    expect(errorOf(() => call("carl", "GET", `/guilds/${guildId}/scheduled-events`)).code).toBe(50001);

    const everyone = db.guilds.get(guildId)!.guild.roles.find(r => r.id === guildId)!;
    everyone.permissions = (DEFAULT_EVERYONE & ~Perm.CREATE_EVENTS).toString();
    expect(errorOf(() => external("bob")).code).toBe(50013);
    expect(errorOf(() => call("alice", "PATCH", `/guilds/${guildId}/scheduled-events/${mine.id}`, { name: "Late" })).code).toBe(50013);
    const role = { id: "9100", name: "events", color: 0, hoist: false, position: 1, permissions: Perm.MANAGE_EVENTS.toString(), mentionable: false };
    db.guilds.get(guildId)!.guild.roles.push(role);
    db.guilds.get(guildId)!.members.get(ids.bob!)!.roles = [role.id];
    expect(external("bob").status).toBe(1);
    expect(call<GuildScheduledEvent>("bob", "PATCH", `/guilds/${guildId}/scheduled-events/${mine.id}`, { name: "Moderated" }).name).toBe("Moderated");
  });

  it("validates the form like the server", () => {
    const post = (body: Record<string, unknown>) => () =>
      call("owner", "POST", `/guilds/${guildId}/scheduled-events`, { name: "x", entity_type: 3, entity_metadata: { location: "x" }, scheduled_start_time: inHours(2), scheduled_end_time: inHours(3), ...body });
    for (const body of [
      { name: " " },
      { scheduled_start_time: inHours(-1) },
      { scheduled_end_time: inHours(1) },
      { scheduled_end_time: null },
      { entity_metadata: null },
      { channel_id: voiceId },
      { entity_type: 2 },
      { entity_type: 7 },
      { scheduled_start_time: "tomorrow" },
      { privacy_level: 1 },
      { recurrence_rule: { start: inHours(2), end: null, frequency: 3, interval: 0, by_weekday: null, count: null } },
      { recurrence_rule: { start: inHours(2), end: null, frequency: 3, interval: 1, by_weekday: [1], count: null } },
    ]) {
      expect(errorOf(post(body)).code).toBe(50035);
    }
    const text = [...db.channels.values()].find(c => c.id === generalId)!;
    expect(errorOf(() => call("owner", "POST", `/guilds/${guildId}/scheduled-events`, { name: "x", entity_type: 2, channel_id: text.id, scheduled_start_time: inHours(2) })).code).toBe(50035);
    const rule = { start: inHours(2), end: null, frequency: 2, interval: 1, by_weekday: [4, 1, 4], count: 10 };
    const event = call<GuildScheduledEvent>("owner", "POST", `/guilds/${guildId}/scheduled-events`, { name: "Game night", entity_type: 2, channel_id: voiceId, scheduled_start_time: inHours(2), recurrence_rule: rule });
    expect(event.recurrence_rule?.by_weekday).toEqual([1, 4]);
    expect(event.channel_id).toBe(voiceId);
  });

  it("clears the channel of an event when the channel is deleted, and Interested follows the membership", () => {
    const event = call<GuildScheduledEvent>("owner", "POST", `/guilds/${guildId}/scheduled-events`, { name: "Voice", entity_type: 2, channel_id: voiceId, scheduled_start_time: inHours(2) });
    call("alice", "PUT", `/guilds/${guildId}/scheduled-events/${event.id}/users/@me`);
    call("owner", "DELETE", `/channels/${voiceId}`);
    expect(call<GuildScheduledEvent>("owner", "GET", `/guilds/${guildId}/scheduled-events/${event.id}`)).toMatchObject({ channel_id: null, status: 1, user_count: 1 });
    call("alice", "DELETE", `/users/@me/guilds/${guildId}`);
    expect(call<GuildScheduledEvent>("owner", "GET", `/guilds/${guildId}/scheduled-events/${event.id}`).user_count).toBe(0);
  });
});

describe("events and channel visibility", () => {
  const privateVoice = (allowed: string[]) => {
    const channel = addChannel(guildId, { name: "staff-voice", type: ChannelType.GuildVoice });
    channel.permission_overwrites = [
      { id: guildId, type: 0, allow: "0", deny: Perm.VIEW_CHANNEL.toString() },
      ...allowed.map(id => ({ id, type: 1, allow: (Perm.VIEW_CHANNEL | Perm.CONNECT).toString(), deny: "0" })),
    ];
    return channel;
  };
  const voiceEvent = (channelId: string, name = "Staff sync") =>
    call<GuildScheduledEvent>("owner", "POST", `/guilds/${guildId}/scheduled-events`, { name, entity_type: 2, channel_id: channelId, scheduled_start_time: inHours(3) });

  it("hides events of a channel the member cannot view, over REST and the gateway", () => {
    join("carl");
    const secret = privateVoice([ids.carl!]);
    const hidden = voiceEvent(secret.id);
    const open = external("owner", "Open house");
    const path = `/guilds/${guildId}/scheduled-events/${hidden.id}`;
    expect(call<GuildScheduledEvent[]>("alice", "GET", `/guilds/${guildId}/scheduled-events`).map(e => e.name)).toEqual(["Open house"]);
    expect(call<GuildScheduledEvent[]>("carl", "GET", `/guilds/${guildId}/scheduled-events`)).toHaveLength(2);
    for (const [method, suffix, body] of [["GET", "", undefined], ["GET", "/users", undefined], ["PUT", "/users/@me", undefined], ["DELETE", "/users/@me", undefined], ["PATCH", "", { name: "x" }], ["DELETE", "", undefined]] as const) {
      expect(errorOf(() => call("alice", method, path + suffix, body)), `${method} ${suffix}`).toEqual({ status: 404, code: 10065 });
    }
    // gateway: create reached carl and the owner but not alice
    const recipients = (t: string, id: string) => eventsOf(t).filter(e => (e.d as GuildScheduledEvent).id === id).flatMap(e => e.users);
    expect(recipients("GUILD_SCHEDULED_EVENT_CREATE", hidden.id).sort()).toEqual([ids.owner!, ids.carl!].sort());
    expect(recipients("GUILD_SCHEDULED_EVENT_CREATE", open.id)).toContain(ids.alice!);
    events.length = 0;
    call("carl", "PUT", `${path}/users/@me`);
    expect(eventsOf("GUILD_SCHEDULED_EVENT_USER_ADD").flatMap(e => e.users)).not.toContain(ids.alice!);
    expect(eventsOf("GUILD_SCHEDULED_EVENT_USER_ADD").flatMap(e => e.users)).toContain(ids.carl!);

    // deleting the channel: carl hears it is gone, the creator keeps it without a channel
    events.length = 0;
    call("owner", "DELETE", `/channels/${secret.id}`);
    expect(recipients("GUILD_SCHEDULED_EVENT_DELETE", hidden.id)).toEqual([ids.carl!]);
    expect(recipients("GUILD_SCHEDULED_EVENT_UPDATE", hidden.id)).toEqual([ids.owner!]);
    expect(call<GuildScheduledEvent[]>("carl", "GET", `/guilds/${guildId}/scheduled-events`).map(e => e.name)).toEqual(["Open house"]);
    expect(call<GuildScheduledEvent>("owner", "GET", path).channel_id).toBeNull();
  });

  it("tells the old viewers an event is gone when it moves into a channel they cannot view", () => {
    join("carl");
    const open = addChannel(guildId, { name: "open-voice", type: ChannelType.GuildVoice });
    const secret = privateVoice([ids.carl!]);
    const event = voiceEvent(open.id, "Game night");
    events.length = 0;
    call("owner", "PATCH", `/guilds/${guildId}/scheduled-events/${event.id}`, { channel_id: secret.id });
    const recipients = (t: string) => eventsOf(t).flatMap(e => e.users);
    expect(recipients("GUILD_SCHEDULED_EVENT_DELETE").sort()).toEqual([ids.alice!, ids.bob!].sort());
    expect(recipients("GUILD_SCHEDULED_EVENT_UPDATE").sort()).toEqual([ids.owner!, ids.carl!].sort());
    expect(call<GuildScheduledEvent[]>("alice", "GET", `/guilds/${guildId}/scheduled-events`)).toEqual([]);
  });

  it("edits an event whose channel is gone, and guards status changes", () => {
    const voice = addChannel(guildId, { name: "stage-ish", type: ChannelType.GuildVoice });
    const event = voiceEvent(voice.id, "Game night");
    call("owner", "DELETE", `/channels/${voice.id}`);
    const path = `/guilds/${guildId}/scheduled-events/${event.id}`;
    expect(call<GuildScheduledEvent>("owner", "PATCH", path, { name: "Game night!" })).toMatchObject({ name: "Game night!", channel_id: null });
    expect(errorOf(() => call("owner", "PATCH", path, { entity_type: 2 })).code).toBe(50035);
    expect(errorOf(() => call("owner", "PATCH", path, { status: 2 })).code).toBe(50035);
    expect(call<GuildScheduledEvent>("owner", "PATCH", path, { status: 4 }).status).toBe(4);

    // CONNECT is rechecked on a status change; starting and moving the start in one request is refused
    const room = addChannel(guildId, { name: "room", type: ChannelType.GuildVoice });
    const second = voiceEvent(room.id, "Second");
    const role = { id: "9400", name: "events", color: 0, hoist: false, position: 1, permissions: Perm.MANAGE_EVENTS.toString(), mentionable: false };
    db.guilds.get(guildId)!.guild.roles.push(role);
    db.guilds.get(guildId)!.members.get(ids.alice!)!.roles = [role.id];
    room.permission_overwrites = [{ id: ids.alice!, type: 1, allow: "0", deny: Perm.CONNECT.toString() }];
    const secondPath = `/guilds/${guildId}/scheduled-events/${second.id}`;
    expect(call<GuildScheduledEvent>("alice", "PATCH", secondPath, { name: "Renamed by alice" }).name).toBe("Renamed by alice");
    expect(errorOf(() => call("alice", "PATCH", secondPath, { status: 2 }))).toEqual({ status: 403, code: 50013 });
    expect(errorOf(() => call("owner", "PATCH", secondPath, { status: 2, scheduled_start_time: inHours(10) })).code).toBe(50035);
    expect(call<GuildScheduledEvent>("owner", "GET", secondPath).status).toBe(1);
    expect(call<GuildScheduledEvent>("owner", "PATCH", secondPath, { status: 2, scheduled_start_time: second.scheduled_start_time }).status).toBe(2);
  });
});

describe("stage events", () => {
  it("need a stage moderator to start, but any event manager can complete; completing ends only the stage the event opened", () => {
    const stage = addChannel(guildId, { name: "town-hall", type: 13 });
    const role = { id: "9400", name: "events", color: 0, hoist: false, position: 1, permissions: Perm.MANAGE_EVENTS.toString(), mentionable: false };
    db.guilds.get(guildId)!.guild.roles.push(role);
    db.guilds.get(guildId)!.members.get(ids.alice!)!.roles = [role.id];
    const create = (name: string) =>
      call<GuildScheduledEvent>("owner", "POST", `/guilds/${guildId}/scheduled-events`, { name, entity_type: 1, channel_id: stage.id, scheduled_start_time: inHours(3) });
    const setStatus = (who: string, event: GuildScheduledEvent, status: number) => () => call<GuildScheduledEvent>(who, "PATCH", `/guilds/${guildId}/scheduled-events/${event.id}`, { status });

    const first = create("Town hall");
    expect(errorOf(setStatus("alice", first, 2))).toEqual({ status: 403, code: 50013 });
    expect(stageInstances.has(stage.id)).toBe(false);
    setStatus("owner", first, 2)();
    expect(stageInstances.get(stage.id)?.topic).toBe("Town hall");
    setStatus("alice", first, 3)();
    expect(stageInstances.has(stage.id)).toBe(true);
    setStatus("owner", create("Second"), 2)();
    call("owner", "DELETE", `/stage-instances/${stage.id}`);

    // a stage a moderator opened by hand is not the event's to end
    call("owner", "POST", "/stage-instances", { channel_id: stage.id, topic: "By hand" });
    const third = create("Third");
    setStatus("owner", third, 2)();
    setStatus("owner", third, 3)();
    expect(stageInstances.get(stage.id)?.topic).toBe("By hand");

    // an event that opened its stage ends it when a moderator completes it
    call("owner", "DELETE", `/stage-instances/${stage.id}`);
    const fourth = create("Fourth");
    setStatus("owner", fourth, 2)();
    expect(stageInstances.has(stage.id)).toBe(true);
    setStatus("owner", fourth, 3)();
    expect(stageInstances.has(stage.id)).toBe(false);
  });
});

describe("onboarding", () => {
  const configure = (extra: Record<string, unknown> = {}) => {
    const gamer = { id: "9201", name: "gamer", color: 0, hoist: false, position: 1, permissions: "0", mentionable: false };
    const painter = { id: "9202", name: "painter", color: 0, hoist: false, position: 2, permissions: "0", mentionable: false };
    db.guilds.get(guildId)!.guild.roles.push(gamer, painter);
    const gaming = addChannel(guildId, { name: "gaming", type: 0 });
    const art = addChannel(guildId, { name: "art", type: 0 });
    const config = call<GuildOnboarding>("owner", "PUT", `/guilds/${guildId}/onboarding`, {
      enabled: true,
      mode: OnboardingMode.Advanced,
      default_channel_ids: [generalId],
      rules: { description: null, items: ["Be kind"] },
      prompts: [
        {
          type: 0,
          title: "What do you play?",
          required: true,
          single_select: true,
          options: [
            { title: "Games", role_ids: [gamer.id], channel_ids: [gaming.id] },
            { title: "Art", role_ids: [painter.id], channel_ids: [art.id] },
          ],
        },
      ],
      ...extra,
    });
    return { config, gamer, painter, gaming, art };
  };

  it("only editors with MANAGE_GUILD and MANAGE_ROLES configure, roles must be below them", () => {
    expect(errorOf(() => call("alice", "PUT", `/guilds/${guildId}/onboarding`, { enabled: true })).code).toBe(50013);
    const { config } = configure();
    expect(call<GuildOnboarding>("alice", "GET", `/guilds/${guildId}/onboarding`)).toEqual({ ...config, rules_pending: false });
    const editor = { id: "9300", name: "editor", color: 0, hoist: false, position: 1, permissions: (Perm.MANAGE_GUILD | Perm.MANAGE_ROLES).toString(), mentionable: false };
    const high = { id: "9301", name: "high", color: 0, hoist: false, position: 5, permissions: "0", mentionable: false };
    db.guilds.get(guildId)!.guild.roles.push(editor, high);
    db.guilds.get(guildId)!.members.get(ids.alice!)!.roles = [editor.id];
    const prompt = (role: string) => ({ prompts: [{ type: 0, title: "Q", options: [{ title: "A", role_ids: [role] }] }] });
    expect(errorOf(() => call("alice", "PUT", `/guilds/${guildId}/onboarding`, prompt(high.id))).code).toBe(50013);
    expect(errorOf(() => call("alice", "PUT", `/guilds/${guildId}/onboarding`, prompt(guildId))).code).toBe(50035);
    expect(errorOf(() => call("owner", "PUT", `/guilds/${guildId}/onboarding`, { default_channel_ids: ["12345"] })).code).toBe(50035);
    expect(errorOf(() => call("owner", "PUT", `/guilds/${guildId}/onboarding`, { rules: { description: null, items: [] } })).code).toBe(50035);
  });

  it("starts new members in the flow, grants and revokes roles from answers", () => {
    const { config, gamer, painter, gaming, art } = configure();
    const [games, artOption] = config.prompts[0]!.options.map(o => o.id) as [string, string];
    join("carl");
    const carl = (): GuildMember => call<GuildMember[]>("owner", "GET", `/guilds/${guildId}/members`).find(m => m.user.id === ids.carl)!;
    expect(carl().flags).toBe(MemberFlags.StartedOnboarding);
    expect(call<GuildMember[]>("owner", "GET", `/guilds/${guildId}/members`).find(m => m.user.id === ids.alice)!.flags).toBeUndefined();

    const answer = (option_ids: string[], rules_accepted?: boolean) => () => call<OnboardingCompletion>("carl", "PUT", `/guilds/${guildId}/onboarding-responses`, { option_ids, rules_accepted });
    expect(errorOf(answer([games])).code).toBe(50035);
    expect(errorOf(answer([games], false)).code).toBe(50035);
    expect(errorOf(answer([], true)).code).toBe(50035);
    expect(errorOf(answer([games, artOption], true)).code).toBe(50035);
    expect(errorOf(answer(["1"], true)).code).toBe(50035);
    expect(carl().roles).toEqual([]);

    const done = answer([games], true)();
    expect(done.member.roles).toEqual([gamer.id]);
    expect(done.member.flags).toBe(MemberFlags.StartedOnboarding | MemberFlags.CompletedOnboarding);
    expect(done.channel_ids).toEqual([generalId, gaming.id]);
    expect(eventsOf("GUILD_MEMBER_UPDATE")).toHaveLength(1);
    expect(call<{ option_ids: string[] }>("carl", "GET", `/guilds/${guildId}/onboarding-responses`).option_ids).toEqual([games]);

    db.guilds.get(guildId)!.members.get(ids.carl!)!.roles.push("9999");
    const changed = answer([artOption], true)();
    expect(changed.member.roles).toEqual(["9999", painter.id]);
    expect(changed.channel_ids).toEqual([generalId, art.id]);

    call("owner", "PUT", `/guilds/${guildId}/onboarding`, { enabled: false });
    expect(errorOf(answer([games], true)).code).toBe(50035);
    join("dana");
    expect(call<GuildMember[]>("owner", "GET", `/guilds/${guildId}/members`).find(m => m.user.id === ids.dana)!.flags).toBeUndefined();
  });

  it("holds members who joined after the rules back from messages and reactions until they accept (150010)", () => {
    const { config } = configure();
    const games = config.prompts[0]!.options[0]!.id;
    const posted = call<{ id: string }>("owner", "POST", `/channels/${generalId}/messages`, { content: "hello" });
    const send = (who: string) => () => call(who, "POST", `/channels/${generalId}/messages`, { content: "hi" });
    const react = (who: string) => () => call(who, "PUT", `/channels/${generalId}/messages/${posted.id}/reactions/${encodeURIComponent("👍")}/@me`);
    const pending = (who: string) => call<GuildOnboarding>(who, "GET", `/guilds/${guildId}/onboarding`).rules_pending;

    join("carl");
    expect(pending("carl")).toBe(true);
    expect(errorOf(send("carl"))).toEqual({ status: 403, code: 150010 });
    expect(errorOf(react("carl"))).toEqual({ status: 403, code: 150010 });
    expect(errorOf(() => call("carl", "POST", `/channels/${generalId}/threads`, { name: "side talk" }))).toEqual({ status: 403, code: 150010 });
    expect(errorOf(() => call("carl", "POST", `/channels/${generalId}/messages/${posted.id}/threads`, { name: "side talk" }))).toEqual({ status: 403, code: 150010 });
    // alice and bob joined before the rules existed, the owner owns the guild: none of them are held
    for (const who of ["alice", "bob", "owner"]) {
      expect(pending(who)).toBe(false);
      send(who)();
    }
    react("alice")();

    call("carl", "PUT", `/guilds/${guildId}/onboarding-responses`, { option_ids: [games], rules_accepted: true });
    expect(pending("carl")).toBe(false);
    send("carl")();
    react("carl")();

    // a member who leaves and joins again after the rules is held, and cannot rewrite old messages either
    const old = call<{ id: string }>("bob", "POST", `/channels/${generalId}/messages`, { content: "old" });
    const bob = db.guilds.get(guildId)!.members.get(ids.bob!)!;
    bob.joined_at = new Date(Date.now() + 1000).toISOString();
    onboardingStartedFor(guildId, ids.bob!);
    expect(errorOf(() => call("bob", "PATCH", `/channels/${generalId}/messages/${old.id}`, { content: "new" })).code).toBe(150010);

    // clearing the rules lifts the hold for members who have not accepted
    join("dana");
    expect(errorOf(send("dana")).code).toBe(150010);
    call("owner", "PUT", `/guilds/${guildId}/onboarding`, { rules: null });
    send("dana")();
  });

  it("lets a member who joined before onboarding existed save their answers (Channels & Roles)", () => {
    const { config } = configure();
    const games = config.prompts[0]!.options[0]!.id;
    expect(call<GuildMember[]>("owner", "GET", `/guilds/${guildId}/members`).find(m => m.user.id === ids.alice)!.flags).toBeUndefined();
    const done = call<OnboardingCompletion>("alice", "PUT", `/guilds/${guildId}/onboarding-responses`, { option_ids: [games], rules_accepted: true });
    expect(done.member.roles).toHaveLength(1);
    expect(call<{ option_ids: string[] }>("alice", "GET", `/guilds/${guildId}/onboarding-responses`).option_ids).toEqual([games]);
  });

  it("only takes back roles that onboarding added, even when the options changed", () => {
    const { config, gamer, painter } = configure();
    const [games, artOption] = config.prompts[0]!.options.map(o => o.id) as [string, string];
    join("carl");
    const answer = (option: string) => call<OnboardingCompletion>("carl", "PUT", `/guilds/${guildId}/onboarding-responses`, { option_ids: [option], rules_accepted: true });
    // painter was theirs before: choosing and dropping Art does not remove it
    db.guilds.get(guildId)!.members.get(ids.carl!)!.roles = [painter.id];
    expect(answer(artOption).member.roles).toEqual([painter.id]);
    expect(answer(games).member.roles.sort()).toEqual([gamer.id, painter.id].sort());
    expect(answer(artOption).member.roles).toEqual([painter.id]);

    // Games is edited to grant painter instead of gamer: the earlier gamer grant is still taken back
    expect(answer(games).member.roles).toContain(gamer.id);
    call("owner", "PUT", `/guilds/${guildId}/onboarding`, {
      prompts: [{ id: config.prompts[0]!.id, type: 0, title: "Q", options: [{ id: games, title: "Games", role_ids: [painter.id] }, { id: artOption, title: "Art", role_ids: [painter.id] }] }],
    });
    expect(answer(artOption).member.roles).toEqual([painter.id]);
  });

  it("lands in the default channels in Default mode and adds the answers' channels in Advanced mode", () => {
    const { config, art } = configure({ mode: OnboardingMode.Default });
    const [, artOption] = config.prompts[0]!.options.map(o => o.id) as [string, string];
    join("carl");
    const answer = () => call<OnboardingCompletion>("carl", "PUT", `/guilds/${guildId}/onboarding-responses`, { option_ids: [artOption], rules_accepted: true });
    expect(answer().channel_ids).toEqual([generalId]);
    call("owner", "PUT", `/guilds/${guildId}/onboarding`, { mode: OnboardingMode.Advanced });
    expect(answer().channel_ids).toEqual([generalId, art.id]);
  });

  it("does not take back a role a moderator gave back", () => {
    const { config, gamer, painter } = configure();
    const [games, art] = config.prompts[0]!.options.map(o => o.id) as [string, string];
    join("carl");
    const answers = (option_ids: string[]) => call<OnboardingCompletion>("carl", "PUT", `/guilds/${guildId}/onboarding-responses`, { option_ids, rules_accepted: true });
    const roles = (list: string[]) => call("owner", "PATCH", `/guilds/${guildId}/members/${ids.carl}`, { roles: list });
    expect(answers([games]).member.roles).toEqual([gamer.id]);
    roles([]);
    roles([gamer.id]);
    expect(answers([art]).member.roles.sort()).toEqual([gamer.id, painter.id].sort());
  });

  it("shows members only the channels they can view, and editors everything", () => {
    const { config } = configure();
    const secret = addChannel(guildId, { name: "staff", type: 0 });
    secret.permission_overwrites = [{ id: guildId, type: 0, allow: "0", deny: Perm.VIEW_CHANNEL.toString() }];
    const option = config.prompts[0]!.options[0]!;
    call("owner", "PUT", `/guilds/${guildId}/onboarding`, {
      default_channel_ids: [generalId, secret.id],
      prompts: [{ id: config.prompts[0]!.id, type: 0, title: "Q", options: [{ id: option.id, title: "Games", role_ids: option.role_ids, channel_ids: [...option.channel_ids, secret.id] }] }],
    });
    join("carl");
    const seen = call<GuildOnboarding>("carl", "GET", `/guilds/${guildId}/onboarding`);
    expect(seen.default_channel_ids).toEqual([generalId]);
    expect(seen.prompts[0]!.options[0]!.channel_ids).not.toContain(secret.id);
    const whole = call<GuildOnboarding>("owner", "GET", `/guilds/${guildId}/onboarding`);
    expect(whole.default_channel_ids).toEqual([generalId, secret.id]);
    expect(whole.prompts[0]!.options[0]!.channel_ids).toContain(secret.id);
  });

  it("filters channels the member cannot see out of the completion", () => {
    const { config } = configure();
    const secret = addChannel(guildId, { name: "secret", type: 0 });
    secret.permission_overwrites = [{ id: guildId, type: 0, allow: "0", deny: Perm.VIEW_CHANNEL.toString() }];
    const option = config.prompts[0]!.options[0]!;
    call("owner", "PUT", `/guilds/${guildId}/onboarding`, {
      prompts: [{ id: config.prompts[0]!.id, type: 0, title: "Q", options: [{ id: option.id, title: "Games", role_ids: option.role_ids, channel_ids: [...option.channel_ids, secret.id] }] }],
    });
    join("carl");
    const done = call<OnboardingCompletion>("carl", "PUT", `/guilds/${guildId}/onboarding-responses`, { option_ids: [option.id], rules_accepted: true });
    expect(done.channel_ids).not.toContain(secret.id);
  });
});

describe("friend suggestions", () => {
  const names = (who: string) => call<FriendSuggestionsResponse>(who, "GET", "/users/@me/friend-suggestions").suggestions.map(s => s.user.username);

  it("ranks shared guilds above hidden mutual friends and respects relationships", () => {
    setRelationship(ids.owner!, ids.carl!, RelationshipType.Friend, RelationshipType.Friend);
    setRelationship(ids.carl!, ids.dana!, RelationshipType.Friend, RelationshipType.Friend);
    // dana shares no guild or DM with owner: no mutual friend count (as on dana's profile), so it ranks after shared guilds.
    expect(names("owner")).toEqual(["alice", "bob", "dana"]);
    const list = call<FriendSuggestionsResponse>("owner", "GET", "/users/@me/friend-suggestions").suggestions;
    expect(list[2]!.mutual_friends_count).toBe(0);
    expect(call<{ mutual_friends_count: number }>("owner", "GET", `/users/${ids.dana}/profile`).mutual_friends_count).toBe(0);
    expect(list[0]!.mutual_guilds).toEqual([{ id: guildId, nick: null }]);
    expect(names("dana")).toEqual(["owner"]);
    expect(errorOf(() => call("owner", "GET", "/users/@me/friend-suggestions?limit=0")).code).toBe(50035);
    setRelationship(ids.owner!, ids.dana!, RelationshipType.OutgoingRequest, RelationshipType.IncomingRequest);
    expect(names("owner")).toEqual(["alice", "bob"]);
  });

  it("hides blocks, opt-outs, dismissals and big guilds", () => {
    setRelationship(ids.alice!, ids.owner!, RelationshipType.Blocked, null);
    expect(names("owner")).toEqual(["bob"]);
    expect(names("alice")).toEqual(["bob"]);
    expect(call("bob", "PATCH", "/users/@me/friend-suggestion-settings", { enabled: false })).toEqual({ enabled: false });
    expect(names("owner")).toEqual([]);
    expect(call("bob", "GET", "/users/@me/friend-suggestions")).toEqual({ enabled: false, suggestions: [] });
    call("bob", "PATCH", "/users/@me/friend-suggestion-settings", { enabled: true });
    call("owner", "DELETE", `/users/@me/friend-suggestions/${ids.bob}`);
    expect(names("owner")).toEqual([]);
    expect(names("bob")).toEqual(["owner", "alice"]);
    expect(call("owner", "DELETE", "/users/@me/friend-suggestions/424242")).toBeUndefined(); // the same answer for ids that belong to nobody
    expect(errorOf(() => call("owner", "PATCH", "/users/@me/friend-suggestion-settings", {})).code).toBe(50035);

    const guild = db.guilds.get(guildId)!;
    for (let i = 0; i < 205; i += 1) guild.members.set(createAccount({ username: `filler${i}` }).user.id, { nick: null, roles: [], joined_at: new Date().toISOString() });
    expect(names("bob")).toEqual([]);
  });
});
