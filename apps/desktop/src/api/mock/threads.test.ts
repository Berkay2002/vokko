import { beforeEach, describe, expect, it, vi } from "vitest";

const events: { users: string[]; t: string; d: unknown }[] = [];
vi.mock("./socket", () => ({
  emit: (users: Iterable<string>, t: string, d: unknown) => {
    events.push({ users: [...users], t, d });
  },
}));

import { ApiRequestError } from "../errors";
import { DEFAULT_EVERYONE, Perm } from "../permissions";
import {
  ChannelFlags,
  ChannelType,
  MessageFlags,
  MessageType,
  OverwriteType,
  ThreadMemberFlags,
  type Channel,
  type ChannelFollower,
  type FollowedChannel,
  type ForumPost,
  type Message,
  type ThreadListResponse,
  type ThreadMember,
  type ThreadSearchResponse,
} from "../types";
import { db } from "./db";
import { addMessage, createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";
import { sweepArchivedThreads } from "./threads";
import { guildPayload } from "./views";

const ids: Record<string, string> = {};
let guildId = "";
let general = "";
let news = "";
let forum = "";
let tags: Record<string, string> = {};

const call = (who: string, method: string, path: string, body?: unknown): unknown => handleRoute(method, path, body ?? null, ids[who] ?? null);
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
const bits = (...p: bigint[]) => p.reduce((a, b) => a | b, 0n).toString();

const say = (who: string, channelId: string, text: string): Message => call(who, "POST", `/channels/${channelId}/messages`, { content: text }) as Message;
const messagesOf = (who: string, channelId: string): Message[] => call(who, "GET", `/channels/${channelId}/messages`) as Message[];
const startFrom = (who: string, parent: string, messageId: string, name = "a thread", extra: object = {}): Channel =>
  call(who, "POST", `/channels/${parent}/messages/${messageId}/threads`, { name, ...extra }) as Channel;
const startThread = (who: string, parent: string, body: object): Channel => call(who, "POST", `/channels/${parent}/threads`, body) as Channel;
const post = (who: string, title: string, text: string, applied_tags: string[] = []): ForumPost =>
  call(who, "POST", `/channels/${forum}/threads`, { name: title, applied_tags, message: { content: text } }) as ForumPost;
const search = (who: string, query = ""): ThreadSearchResponse => call(who, "GET", `/channels/${forum}/threads/search${query}`) as ThreadSearchResponse;
const patch = (who: string, channelId: string, body: object): Channel => call(who, "PATCH", `/channels/${channelId}`, body) as Channel;
const activeIds = (who: string): string[] => (call(who, "GET", `/guilds/${guildId}/threads/active`) as ThreadListResponse).threads.map(t => t.id);
const setOverwrites = (channelId: string, allow: bigint, deny: bigint): void => {
  db.channels.get(channelId)!.permission_overwrites = [{ id: guildId, type: OverwriteType.Role, allow: allow.toString(), deny: deny.toString() }];
};

beforeEach(() => {
  events.length = 0;
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending, db.followers] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "mod", "plain", "other", "outsider"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Test guild");
  const guild = db.guilds.get(guildId)!;
  guild.guild.roles.push({ id: "9002", name: "mod", color: 0, hoist: false, position: 2, permissions: bits(Perm.MANAGE_THREADS, Perm.MANAGE_WEBHOOKS, Perm.MANAGE_CHANNELS, Perm.MANAGE_MESSAGES), mentionable: false });
  const joined = new Date().toISOString();
  guild.members.set(ids.mod!, { nick: null, roles: ["9002"], joined_at: joined });
  guild.members.set(ids.plain!, { nick: null, roles: [], joined_at: joined });
  guild.members.set(ids.other!, { nick: null, roles: [], joined_at: joined });
  general = [...db.channels.values()].find(c => c.guild_id === guildId && c.name === "general")!.id;
  news = (call("owner", "POST", `/guilds/${guildId}/channels`, { name: "news", type: ChannelType.GuildAnnouncement }) as Channel).id;
  const created = call("owner", "POST", `/guilds/${guildId}/channels`, {
    name: "support",
    type: ChannelType.GuildForum,
    available_tags: [{ name: "Bug" }, { name: "Question" }, { name: "Solved", moderated: true }],
  }) as Channel;
  forum = created.id;
  tags = Object.fromEntries((created.available_tags ?? []).map(t => [t.name, t.id]));
  events.length = 0;
});

describe("threads from a message", () => {
  it("uses the message id, adds a type 21 starter and tells the viewers", () => {
    const m = say("plain", general, "hello world");
    const thread = startFrom("plain", general, m.id, "talk about hello");
    expect(thread).toMatchObject({ id: m.id, type: ChannelType.PublicThread, parent_id: general, owner_id: ids.plain, name: "talk about hello", newly_created: true });
    expect(thread.thread_metadata).toMatchObject({ archived: false, locked: false, auto_archive_duration: 1440 });
    expect(thread.member_count).toBe(1);
    expect(thread.member?.user_id).toBe(ids.plain);
    const inside = messagesOf("other", thread.id);
    expect(inside).toHaveLength(1);
    expect(inside[0]).toMatchObject({ type: MessageType.ThreadStarterMessage, message_reference: { message_id: m.id, channel_id: general } });
    expect(inside[0]?.referenced_message?.content).toBe("hello world");
    // the parent message carries the thread now, and the guild payload lists it as active, not among the channels
    expect(messagesOf("other", general).find(x => x.id === m.id)?.thread?.id).toBe(m.id);
    const payload = guildPayload(guildId, ids.other!);
    expect(payload.threads?.map(t => t.id)).toEqual([m.id]);
    expect(payload.channels.some(c => c.id === m.id)).toBe(false);
    expect((call("other", "GET", `/guilds/${guildId}/channels`) as Channel[]).some(c => c.id === m.id)).toBe(false);
    expect(eventsOf("THREAD_CREATE").flatMap(e => e.users)).toEqual(expect.arrayContaining([ids.plain!, ids.other!]));
    expect((eventsOf("THREAD_CREATE")[0]?.d as Channel).newly_created).toBe(true);
    expect(eventsOf("MESSAGE_UPDATE").some(e => (e.d as Message).id === m.id && (e.d as Message).thread?.id === m.id)).toBe(true);
  });

  it("allows one thread per message, none from inside a thread, and checks the name and duration", () => {
    const m = say("plain", general, "once");
    startFrom("plain", general, m.id);
    expect(errorOf(() => startFrom("other", general, m.id)).code).toBe(160004);
    const starter = messagesOf("plain", m.id)[0]!;
    expect(errorOf(() => startFrom("plain", m.id, starter.id)).code).toBe(50024);
    const second = say("plain", general, "twice");
    expect(errorOf(() => startFrom("plain", general, second.id, "")).code).toBe(50035);
    expect(errorOf(() => startFrom("plain", general, second.id, "x".repeat(101))).code).toBe(50035);
    expect(errorOf(() => startFrom("plain", general, second.id, "ok", { auto_archive_duration: 5 })).code).toBe(50035);
    expect(startFrom("plain", general, second.id, "ok", { auto_archive_duration: 60 }).thread_metadata?.auto_archive_duration).toBe(60);
  });

  it("starts an announcement thread (type 10) in an announcement channel", () => {
    const m = say("owner", news, "release notes");
    expect(startFrom("plain", news, m.id).type).toBe(ChannelType.AnnouncementThread);
  });

  it("needs CREATE_PUBLIC_THREADS and a text or announcement parent", () => {
    const m = say("plain", general, "denied");
    db.guilds.get(guildId)!.guild.roles.find(r => r.id === guildId)!.permissions = (DEFAULT_EVERYONE & ~Perm.CREATE_PUBLIC_THREADS).toString();
    expect(errorOf(() => startFrom("plain", general, m.id)).code).toBe(50013);
    expect(errorOf(() => startFrom("mod", general, m.id)).code).toBe(50013); // the mod role does not carry the bit either
    expect(startFrom("owner", general, m.id).id).toBe(m.id);
  });
});

describe("threads without a message", () => {
  it("public: posts a type 18 notice in the parent; private: no notice and hidden from non-members", () => {
    const pub = startThread("plain", general, { name: "open talk" });
    expect(pub).toMatchObject({ type: ChannelType.PublicThread, name: "open talk" });
    const notice = messagesOf("other", general).find(m => m.type === MessageType.ThreadCreated);
    expect(notice).toMatchObject({ content: "open talk", message_reference: { channel_id: pub.id } });

    const before = messagesOf("other", general).length;
    const priv = startThread("plain", general, { name: "secret", type: ChannelType.PrivateThread });
    expect(priv.type).toBe(ChannelType.PrivateThread);
    expect(priv.thread_metadata?.invitable).toBe(true);
    expect(messagesOf("other", general)).toHaveLength(before);
    expect(errorOf(() => messagesOf("other", priv.id)).code).toBe(50001);
    expect(activeIds("other")).toEqual([pub.id]);
    expect(activeIds("plain")).toEqual(expect.arrayContaining([pub.id, priv.id]));
    expect(activeIds("mod")).toContain(priv.id); // MANAGE_THREADS sees every private thread
    const audience = eventsOf("THREAD_CREATE").filter(e => (e.d as Channel).id === priv.id).flatMap(e => e.users);
    expect(audience).toContain(ids.plain);
    expect(audience).not.toContain(ids.other);
  });

  it("private threads need CREATE_PRIVATE_THREADS", () => {
    db.guilds.get(guildId)!.guild.roles.find(r => r.id === guildId)!.permissions = (DEFAULT_EVERYONE & ~Perm.CREATE_PRIVATE_THREADS).toString();
    expect(errorOf(() => startThread("plain", general, { name: "no", type: ChannelType.PrivateThread })).code).toBe(50013);
    expect(startThread("plain", general, { name: "yes" }).type).toBe(ChannelType.PublicThread);
  });

  it("adding a member to a private thread shows it to them (THREAD_CREATE with their membership)", () => {
    const priv = startThread("plain", general, { name: "secret", type: ChannelType.PrivateThread });
    events.length = 0;
    expect(call("plain", "PUT", `/channels/${priv.id}/thread-members/${ids.other}`)).toBeUndefined();
    const created = eventsOf("THREAD_CREATE").find(e => e.users.includes(ids.other!));
    expect((created?.d as Channel).member?.user_id).toBe(ids.other);
    expect(messagesOf("other", priv.id)).toEqual([]);
    expect(eventsOf("THREAD_MEMBER_UPDATE")[0]?.users).toEqual([ids.other]);
    expect(activeIds("other")).toContain(priv.id);
  });
});

describe("permissions inside a thread", () => {
  it("SEND_MESSAGES_IN_THREADS replaces SEND_MESSAGES", () => {
    const thread = startThread("plain", general, { name: "talk" });
    setOverwrites(general, 0n, Perm.SEND_MESSAGES);
    expect(errorOf(() => say("other", general, "blocked")).code).toBe(50013);
    expect(say("other", thread.id, "still fine in the thread").channel_id).toBe(thread.id);
    setOverwrites(general, 0n, Perm.SEND_MESSAGES_IN_THREADS);
    expect(say("other", general, "fine in the channel").channel_id).toBe(general);
    expect(errorOf(() => say("other", thread.id, "blocked in the thread")).code).toBe(50013);
    expect(errorOf(() => call("other", "POST", `/channels/${thread.id}/typing`)).code).toBe(50013);
  });

  it("a thread is hidden together with its parent", () => {
    const thread = startThread("plain", general, { name: "talk" });
    setOverwrites(general, 0n, Perm.VIEW_CHANNEL);
    expect(errorOf(() => messagesOf("other", thread.id)).code).toBe(50001);
    expect(activeIds("other")).toEqual([]);
  });
});

describe("members", () => {
  it("join, leave and list with the matching events", () => {
    const thread = startThread("plain", general, { name: "talk" });
    events.length = 0;
    expect(call("other", "PUT", `/channels/${thread.id}/thread-members/@me`)).toBeUndefined();
    expect(call("other", "PUT", `/channels/${thread.id}/thread-members/@me`)).toBeUndefined(); // already a member
    const joined = eventsOf("THREAD_MEMBER_UPDATE");
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ users: [ids.other], d: { id: thread.id, user_id: ids.other, guild_id: guildId } });
    const update = eventsOf("THREAD_MEMBERS_UPDATE")[0]?.d as { member_count: number; added_members?: ThreadMember[] };
    expect(update.member_count).toBe(2);
    expect(update.added_members?.[0]?.user_id).toBe(ids.other);
    const list = call("plain", "GET", `/channels/${thread.id}/thread-members`) as ThreadMember[];
    expect(list.map(m => m.user_id).sort()).toEqual([ids.plain, ids.other].sort());
    expect((call("plain", "GET", `/channels/${thread.id}/thread-members/${ids.other}`) as ThreadMember).user_id).toBe(ids.other);
    expect(errorOf(() => call("plain", "GET", `/channels/${thread.id}/thread-members/${ids.mod}`)).code).toBe(10065);

    events.length = 0;
    call("other", "DELETE", `/channels/${thread.id}/thread-members/@me`);
    const left = eventsOf("THREAD_MEMBERS_UPDATE")[0]?.d as { member_count: number; removed_member_ids?: string[] };
    expect(left).toMatchObject({ member_count: 1, removed_member_ids: [ids.other] });
    expect(errorOf(() => call("other", "GET", `/channels/${thread.id}/thread-members/${ids.other}`)).code).toBe(10065);
  });

  it("PATCH @me sets the notify level and mute, to that user only", () => {
    const thread = startThread("plain", general, { name: "talk" });
    const me = `/channels/${thread.id}/thread-members/@me`;
    expect(errorOf(() => call("other", "PATCH", me, { flags: 2 })).code).toBe(10065);
    call("other", "PUT", me);
    events.length = 0;
    const member = call("other", "PATCH", me, { flags: ThreadMemberFlags.OnlyMentions }) as ThreadMember;
    expect(member).toMatchObject({ flags: 4, muted: false, mute_config: null });
    expect(eventsOf("THREAD_MEMBER_UPDATE")).toHaveLength(1);
    expect(eventsOf("THREAD_MEMBER_UPDATE")[0]).toMatchObject({ users: [ids.other], d: { id: thread.id, flags: 4, guild_id: guildId } });
    expect((call("other", "GET", me) as ThreadMember).flags).toBe(4);
    expect((call("plain", "GET", `/channels/${thread.id}/thread-members/${ids.other}`) as ThreadMember).flags).toBe(4);
    expect((call("other", "GET", `/guilds/${guildId}/threads/active`) as ThreadListResponse).members.find(m => m.id === thread.id)?.flags).toBe(4);
    for (const flags of [6, 14, 16]) expect(errorOf(() => call("other", "PATCH", me, { flags })).code).toBe(50035);
    expect((call("other", "PATCH", me, { flags: 0 }) as ThreadMember).flags).toBe(0);

    expect(call("other", "PATCH", me, { muted: true, mute_config: null })).toMatchObject({ muted: true, mute_config: { end_time: null } });
    const end = new Date(Date.now() + 3_600_000).toISOString();
    expect(call("other", "PATCH", me, { muted: true, mute_config: { end_time: end } })).toMatchObject({ muted: true, mute_config: { end_time: end } });
    expect(errorOf(() => call("other", "PATCH", me, { mute_config: { end_time: "2000-01-01T00:00:00.000Z" } })).code).toBe(50035);
    expect(call("other", "PATCH", me, { muted: false })).toMatchObject({ muted: false, mute_config: null });
  });

  it("a timed mute that has ended reads as unmuted; archived threads still take settings", () => {
    const thread = startThread("plain", general, { name: "talk" });
    const me = `/channels/${thread.id}/thread-members/@me`;
    call("other", "PUT", me);
    call("other", "PATCH", me, { muted: true, mute_config: { end_time: new Date(Date.now() + 60_000).toISOString() } });
    db.channels.get(thread.id)?.thread_member_settings?.set(ids.other ?? "", { flags: 0, muted: true, end_time: new Date(Date.now() - 1000).toISOString() });
    expect(call("other", "GET", me)).toMatchObject({ muted: false, mute_config: null });
    // `mute_config: null` alone changes nothing; a config object alone mutes
    expect(call("other", "PATCH", me, { mute_config: null })).toMatchObject({ muted: false, mute_config: null });
    expect(call("other", "PATCH", me, { mute_config: { end_time: null } })).toMatchObject({ muted: true, mute_config: { end_time: null } });
    patch("plain", thread.id, { archived: true });
    expect((call("other", "PATCH", me, { flags: ThreadMemberFlags.NoMessages }) as ThreadMember).flags).toBe(8);
  });

  it("sending joins the sender; mentioning does not", () => {
    const thread = startThread("plain", general, { name: "talk" });
    say("other", thread.id, `hi <@${ids.mod}>`);
    const members = (call("plain", "GET", `/channels/${thread.id}/thread-members`) as ThreadMember[]).map(m => m.user_id);
    expect(members).toContain(ids.other);
    expect(members).not.toContain(ids.mod);
  });

  it("the owner or MANAGE_THREADS removes members; other members cannot", () => {
    const thread = startThread("plain", general, { name: "talk" });
    call("other", "PUT", `/channels/${thread.id}/thread-members/@me`);
    call("mod", "PUT", `/channels/${thread.id}/thread-members/@me`);
    expect(errorOf(() => call("other", "DELETE", `/channels/${thread.id}/thread-members/${ids.mod}`)).code).toBe(50013);
    call("plain", "DELETE", `/channels/${thread.id}/thread-members/${ids.other}`);
    call("mod", "DELETE", `/channels/${thread.id}/thread-members/${ids.plain}`);
    expect((call("mod", "GET", `/channels/${thread.id}/thread-members`) as ThreadMember[]).map(m => m.user_id)).toEqual([ids.mod]);
  });

  it("adding members needs the owner, MANAGE_THREADS or an invitable private thread", () => {
    const thread = startThread("plain", general, { name: "talk" });
    expect(errorOf(() => call("other", "PUT", `/channels/${thread.id}/thread-members/${ids.mod}`)).code).toBe(50013);
    call("mod", "PUT", `/channels/${thread.id}/thread-members/${ids.other}`);
    expect(errorOf(() => call("plain", "PUT", `/channels/${thread.id}/thread-members/${ids.outsider}`)).code).toBe(50035); // not a member of the guild
    const priv = startThread("plain", general, { name: "closed", type: ChannelType.PrivateThread, invitable: false });
    call("plain", "PUT", `/channels/${priv.id}/thread-members/${ids.other}`);
    expect(errorOf(() => call("other", "PUT", `/channels/${priv.id}/thread-members/${ids.mod}`)).code).toBe(50013);
    patch("plain", priv.id, { invitable: true });
    call("other", "PUT", `/channels/${priv.id}/thread-members/${ids.mod}`);
  });
});

describe("archive, lock and auto-archive", () => {
  it("the owner archives and unarchives; others cannot", () => {
    const thread = startThread("plain", general, { name: "talk" });
    expect(errorOf(() => patch("other", thread.id, { archived: true })).code).toBe(50013);
    events.length = 0;
    const archived = patch("plain", thread.id, { archived: true });
    expect(archived.thread_metadata?.archived).toBe(true);
    expect(Date.parse(archived.thread_metadata?.archive_timestamp ?? "")).toBeGreaterThanOrEqual(Date.parse(thread.thread_metadata?.archive_timestamp ?? ""));
    expect((eventsOf("THREAD_UPDATE")[0]?.d as Channel).thread_metadata?.archived).toBe(true);
    expect(activeIds("plain")).not.toContain(thread.id);
    const list = call("other", "GET", `/channels/${general}/threads/archived/public`) as ThreadListResponse;
    expect(list.threads.map(t => t.id)).toEqual([thread.id]);
    expect(list.has_more).toBe(false);
    expect(patch("plain", thread.id, { archived: false }).thread_metadata?.archived).toBe(false);
    expect(activeIds("plain")).toContain(thread.id);
  });

  it("sending unarchives; joining, editing and reacting do not work while archived", () => {
    const thread = startThread("plain", general, { name: "talk" });
    const own = say("plain", thread.id, "first");
    patch("plain", thread.id, { archived: true });
    expect(errorOf(() => call("other", "PUT", `/channels/${thread.id}/thread-members/@me`)).code).toBe(50083);
    expect(errorOf(() => call("plain", "PATCH", `/channels/${thread.id}/messages/${own.id}`, { content: "edited" })).code).toBe(50083);
    expect(errorOf(() => call("plain", "PUT", `/channels/${thread.id}/messages/${own.id}/reactions/${encodeURIComponent("👍")}/@me`)).code).toBe(50083);
    expect(errorOf(() => patch("plain", thread.id, { name: "renamed" })).code).toBe(50083);
    events.length = 0;
    say("other", thread.id, "wakes it up");
    expect(eventsOf("THREAD_UPDATE").some(e => (e.d as Channel).thread_metadata?.archived === false)).toBe(true);
    expect(activeIds("other")).toContain(thread.id);
    expect(patch("plain", thread.id, { name: "renamed" }).name).toBe("renamed");
  });

  it("locked: only MANAGE_THREADS can send, edit or unarchive", () => {
    const thread = startThread("plain", general, { name: "talk" });
    expect(errorOf(() => patch("plain", thread.id, { locked: true })).code).toBe(50013);
    expect(patch("mod", thread.id, { locked: true }).thread_metadata?.locked).toBe(true);
    expect(errorOf(() => say("plain", thread.id, "owner is locked out too")).code).toBe(160005);
    expect(errorOf(() => patch("plain", thread.id, { name: "x" })).code).toBe(160005);
    expect(say("mod", thread.id, "moderators can").channel_id).toBe(thread.id);
    patch("mod", thread.id, { archived: true });
    expect(errorOf(() => patch("plain", thread.id, { archived: false })).code).toBe(160005);
    expect(patch("mod", thread.id, { archived: false, locked: false }).thread_metadata).toMatchObject({ archived: false, locked: false });
    expect(say("plain", thread.id, "open again").channel_id).toBe(thread.id);
  });

  it("archives idle threads after their auto-archive duration", () => {
    const quick = startThread("plain", general, { name: "quick", auto_archive_duration: 60 });
    const slow = startThread("plain", general, { name: "slow", auto_archive_duration: 10080 });
    say("plain", quick.id, "hello");
    events.length = 0;
    expect(sweepArchivedThreads(Date.now() + 30 * 60_000)).toEqual([]);
    expect(sweepArchivedThreads(Date.now() + 61 * 60_000)).toEqual([quick.id]);
    const update = eventsOf("THREAD_UPDATE").find(e => (e.d as Channel).id === quick.id);
    expect((update?.d as Channel).thread_metadata?.archived).toBe(true);
    expect(activeIds("plain")).toEqual([slow.id]);
    expect(patch("plain", quick.id, { auto_archive_duration: 4320, archived: false }).thread_metadata).toMatchObject({ archived: false, auto_archive_duration: 4320 });
    expect(errorOf(() => patch("plain", quick.id, { auto_archive_duration: 7 })).code).toBe(50035);
  });

  it("archived lists page by archive time and keep private threads for managers and members", () => {
    const made = [1, 2, 3].map(n => startThread("plain", general, { name: `t${n}` }));
    const priv = startThread("plain", general, { name: "private", type: ChannelType.PrivateThread });
    for (const t of [...made, priv]) patch("plain", t.id, { archived: true });
    for (const [i, t] of [...made, priv].entries()) db.channels.get(t.id)!.thread_metadata!.archive_timestamp = new Date(Date.now() - (10 - i) * 60_000).toISOString();
    const first = call("other", "GET", `/channels/${general}/threads/archived/public?limit=2`) as ThreadListResponse;
    expect(first.threads.map(t => t.name)).toEqual(["t3", "t2"]);
    expect(first.has_more).toBe(true);
    const rest = call("other", "GET", `/channels/${general}/threads/archived/public?limit=2&before=${encodeURIComponent(first.threads[1]!.thread_metadata!.archive_timestamp)}`) as ThreadListResponse;
    expect(rest.threads.map(t => t.name)).toEqual(["t1"]);
    expect(rest.has_more).toBe(false);
    expect(errorOf(() => call("plain", "GET", `/channels/${general}/threads/archived/private`)).code).toBe(50013);
    expect((call("mod", "GET", `/channels/${general}/threads/archived/private`) as ThreadListResponse).threads.map(t => t.name)).toEqual(["private"]);
    expect((call("plain", "GET", `/channels/${general}/users/@me/threads/archived/private`) as ThreadListResponse).threads.map(t => t.name)).toEqual(["private"]);
    expect((call("other", "GET", `/channels/${general}/users/@me/threads/archived/private`) as ThreadListResponse).threads).toEqual([]);
  });

  it("active lists carry the caller's memberships and message counts", () => {
    const thread = startThread("plain", general, { name: "talk" });
    say("plain", thread.id, "one");
    say("other", thread.id, "two");
    const mine = call("other", "GET", `/guilds/${guildId}/threads/active`) as ThreadListResponse;
    expect(mine.threads[0]).toMatchObject({ id: thread.id, message_count: 2, member_count: 2 });
    expect(mine.members.map(m => m.user_id)).toEqual([ids.other]);
    expect((call("mod", "GET", `/guilds/${guildId}/threads/active`) as ThreadListResponse).members).toEqual([]);
  });
});

describe("deleting threads", () => {
  it("the owner or MANAGE_THREADS deletes; the starter message loses its thread", () => {
    const m = say("plain", general, "root");
    const thread = startFrom("plain", general, m.id);
    expect(errorOf(() => call("other", "DELETE", `/channels/${thread.id}`)).code).toBe(50013);
    events.length = 0;
    call("plain", "DELETE", `/channels/${thread.id}`);
    expect(eventsOf("THREAD_DELETE")[0]?.d).toEqual({ id: thread.id, guild_id: guildId, parent_id: general, type: ChannelType.PublicThread });
    expect(messagesOf("other", general).find(x => x.id === m.id)?.thread).toBeUndefined();
    expect(errorOf(() => messagesOf("other", thread.id)).status).toBe(404);
    const again = startThread("other", general, { name: "again" });
    call("mod", "DELETE", `/channels/${again.id}`);
    expect(activeIds("other")).toEqual([]);
  });

  it("deleting the parent deletes its threads first", () => {
    const thread = startThread("plain", general, { name: "talk" });
    events.length = 0;
    call("owner", "DELETE", `/channels/${general}`);
    const types = events.map(e => e.t);
    expect(types).toContain("THREAD_DELETE");
    expect(types.indexOf("THREAD_DELETE")).toBeLessThan(types.indexOf("CHANNEL_DELETE"));
    expect(db.channels.has(thread.id)).toBe(false);
  });
});

describe("forum channels", () => {
  it("creates a forum with tags and defaults; posts are threads whose first message shares the id", () => {
    const channel = db.channels.get(forum)!;
    expect(channel.available_tags?.map(t => t.name)).toEqual(["Bug", "Question", "Solved"]);
    expect(channel.available_tags?.every(t => /^\d+$/.test(t.id))).toBe(true);
    const created = post("plain", "App crashes", "It crashes on start", [tags.Bug!]);
    expect(created).toMatchObject({ type: ChannelType.PublicThread, parent_id: forum, applied_tags: [tags.Bug], owner_id: ids.plain, newly_created: true });
    expect(created.message).toMatchObject({ id: created.id, channel_id: created.id, content: "It crashes on start", type: MessageType.Default });
    expect(created.message_count).toBe(0);
    expect(messagesOf("other", created.id).map(m => m.id)).toEqual([created.id]);
    expect(eventsOf("THREAD_CREATE").map(e => (e.d as Channel).id)).toContain(created.id);
    expect(eventsOf("MESSAGE_CREATE").some(e => (e.d as Message).id === created.id)).toBe(true);
    say("other", created.id, "same here");
    expect((search("plain").threads[0] as Channel).message_count).toBe(1);
  });

  it("validates tags, requires them when asked and keeps messages out of the forum itself", () => {
    expect(errorOf(() => post("plain", "x", "y", ["123"])).code).toBe(50035);
    expect(errorOf(() => post("plain", "mod only", "y", [tags.Solved!])).code).toBe(50013);
    expect(post("mod", "mod only", "y", [tags.Solved!]).applied_tags).toEqual([tags.Solved]);
    expect(errorOf(() => post("plain", "", "y")).code).toBe(50035);
    expect(errorOf(() => call("plain", "POST", `/channels/${forum}/threads`, { name: "no body", message: { content: "  " } })).code).toBe(50035);
    expect(errorOf(() => say("plain", forum, "direct")).code).toBe(50024);
    const six = Array.from({ length: 6 }, (_, i) => `t${i}`);
    patch("owner", forum, { available_tags: six.map(name => ({ name })) });
    const all = db.channels.get(forum)!.available_tags!.map(t => t.id);
    expect(errorOf(() => post("plain", "many", "y", all)).code).toBe(50035);
    patch("owner", forum, { flags: ChannelFlags.RequireTag });
    expect(errorOf(() => post("plain", "no tag", "y")).code).toBe(220003);
    expect(post("plain", "tagged", "y", all.slice(0, 1)).applied_tags).toHaveLength(1);
    expect(errorOf(() => patch("plain", forum, { default_sort_order: 1 })).code).toBe(50013);
  });

  it("edits the tag list: renames keep ids, removed tags leave their posts (THREAD_UPDATE each)", () => {
    const bug = post("plain", "bug one", "a", [tags.Bug!, tags.Question!]);
    const other = post("plain", "bug two", "b", [tags.Bug!]);
    events.length = 0;
    const next = patch("owner", forum, {
      available_tags: [{ id: tags.Bug, name: "Defect" }, { name: "Idea" }],
      default_reaction_emoji: { emoji_id: null, emoji_name: "👍" },
      default_sort_order: 1,
      default_forum_layout: 2,
    });
    expect(next.available_tags?.map(t => t.name)).toEqual(["Defect", "Idea"]);
    expect(next.available_tags?.[0]?.id).toBe(tags.Bug);
    expect(next).toMatchObject({ default_reaction_emoji: { emoji_name: "👍" }, default_sort_order: 1, default_forum_layout: 2 });
    expect(search("plain").threads.find(t => t.id === bug.id)?.applied_tags).toEqual([tags.Bug]);
    expect([...new Set(eventsOf("THREAD_UPDATE").map(e => (e.d as Channel).id))]).toEqual([bug.id]);
    expect(search("plain").threads.find(t => t.id === other.id)?.applied_tags).toEqual([tags.Bug]);
    expect(patch("owner", forum, { default_reaction_emoji: null }).default_reaction_emoji).toBeUndefined();
    expect(errorOf(() => patch("owner", forum, { available_tags: [{ name: "x".repeat(21) }] })).code).toBe(50035);
    expect(errorOf(() => patch("owner", forum, { available_tags: Array.from({ length: 21 }, (_, i) => ({ name: `t${i}` })) })).code).toBe(50035);
  });

  it("searches posts: tag filter, title, archived, pinned first, sort and paging", () => {
    const a = post("plain", "Alpha crash", "first", [tags.Bug!]);
    const b = post("other", "Beta question", "second", [tags.Question!]);
    const c = post("plain", "Gamma both", "third", [tags.Bug!, tags.Question!]);
    const names = (query = "") => search("plain", query).threads.map(t => t.name);
    expect(names()).toEqual(["Gamma both", "Beta question", "Alpha crash"]); // latest activity first
    say("other", a.id, "bump"); // activity moves Alpha to the top
    expect(names()).toEqual(["Alpha crash", "Gamma both", "Beta question"]);
    expect(names(`?sort_by=creation_time`)).toEqual(["Gamma both", "Beta question", "Alpha crash"]);
    expect(names(`?sort_by=creation_time&sort_order=asc`)).toEqual(["Alpha crash", "Beta question", "Gamma both"]);
    expect(names(`?tag=${tags.Bug}`)).toEqual(["Alpha crash", "Gamma both"]);
    expect(names(`?tag=${tags.Bug}&tag=${tags.Question}`)).toEqual(["Alpha crash", "Gamma both", "Beta question"]);
    expect(names(`?tag=${tags.Bug}&tag=${tags.Question}&tag_setting=match_all`)).toEqual(["Gamma both"]);
    expect(names(`?name=BETA`)).toEqual(["Beta question"]);
    patch("mod", b.id, { flags: ChannelFlags.Pinned });
    expect(names()[0]).toBe("Beta question");
    expect(names(`?sort_order=asc`)[0]).toBe("Beta question"); // pinned stays first either way
    patch("plain", c.id, { archived: true });
    expect(names(`?archived=true`)).toEqual(["Gamma both"]);
    expect(names(`?archived=false`)).toEqual(["Beta question", "Alpha crash"]);
    const page = search("plain", `?limit=2`);
    expect(page).toMatchObject({ has_more: true, total_results: 3 });
    expect(page.first_messages.map(m => m.content)).toEqual(["second", "first"]);
    expect(search("plain", `?limit=2&offset=2`)).toMatchObject({ has_more: false, total_results: 3 });
    expect(page.members.map(m => m.id)).toEqual(expect.arrayContaining([a.id]));
    expect(errorOf(() => patch("plain", b.id, { flags: ChannelFlags.Pinned })).code).toBe(50013);
  });

  it("search also works in a text channel and needs access to the channel", () => {
    startThread("plain", general, { name: "needle thread" });
    startThread("plain", general, { name: "other" });
    const found = call("other", "GET", `/channels/${general}/threads/search?name=needle`) as ThreadSearchResponse;
    expect(found.threads.map(t => t.name)).toEqual(["needle thread"]);
    expect(errorOf(() => call("outsider", "GET", `/channels/${forum}/threads/search`)).code).toBe(50001);
  });
});

describe("announcement channels", () => {
  const follow = (who: string, source: string, target: string): FollowedChannel => call(who, "POST", `/channels/${source}/followers`, { webhook_channel_id: target }) as FollowedChannel;

  it("follow needs MANAGE_WEBHOOKS on the target, an announcement source and another channel", () => {
    expect(errorOf(() => follow("plain", news, general)).code).toBe(50013);
    expect(errorOf(() => follow("mod", general, news)).code).toBe(50035);
    expect(errorOf(() => follow("mod", news, news)).code).toBe(50035);
    expect(errorOf(() => follow("mod", news, forum)).code).toBe(50035);
    const made = follow("mod", news, general);
    expect(made.channel_id).toBe(news);
    expect(follow("mod", news, general).webhook_id).toBe(made.webhook_id); // repeating returns the same follow
    const followers = call("mod", "GET", `/channels/${general}/followers`) as ChannelFollower[];
    expect(followers).toEqual([{ id: made.webhook_id, channel_id: general, guild_id: guildId, source_channel_id: news, source_channel_name: "news", source_guild_id: guildId, source_guild_name: "Test guild" }]);
    expect(errorOf(() => call("plain", "GET", `/channels/${general}/followers`)).code).toBe(50013);
  });

  it("publishing copies the message into every follower channel, once", () => {
    const target = (call("owner", "POST", `/guilds/${guildId}/channels`, { name: "feed", type: ChannelType.GuildText }) as Channel).id;
    follow("mod", news, general);
    follow("mod", news, target);
    const own = say("mod", news, "release **0.5**");
    expect(errorOf(() => call("plain", "POST", `/channels/${news}/messages/${own.id}/crosspost`)).code).toBe(50013);
    events.length = 0;
    const published = call("mod", "POST", `/channels/${news}/messages/${own.id}/crosspost`) as Message;
    expect((published.flags ?? 0) & MessageFlags.Crossposted).toBe(MessageFlags.Crossposted);
    for (const channelId of [general, target]) {
      const copy = messagesOf("plain", channelId).find(m => (m.flags ?? 0) & MessageFlags.IsCrosspost);
      expect(copy).toMatchObject({ content: "release **0.5**", author: { id: ids.mod }, attachments: [], message_reference: { message_id: own.id, channel_id: news, guild_id: guildId } });
    }
    const copies = eventsOf("MESSAGE_CREATE").filter(e => ((e.d as Message).flags ?? 0) & MessageFlags.IsCrosspost);
    expect(new Set(copies.map(e => (e.d as Message).channel_id))).toEqual(new Set([general, target]));
    expect(eventsOf("MESSAGE_UPDATE").some(e => (e.d as Message).id === own.id)).toBe(true);
    expect(errorOf(() => call("mod", "POST", `/channels/${news}/messages/${own.id}/crosspost`)).code).toBe(40033);
    expect(errorOf(() => call("mod", "POST", `/channels/${general}/messages/${say("mod", general, "x").id}/crosspost`)).code).toBe(50024);
  });

  it("another author's message needs MANAGE_MESSAGES; unfollow and deleting the target end the follow", () => {
    const made = follow("mod", news, general);
    const theirs = say("owner", news, "owner says");
    expect(call("mod", "POST", `/channels/${news}/messages/${theirs.id}/crosspost`)).toMatchObject({ id: theirs.id });
    expect(errorOf(() => call("plain", "DELETE", `/channels/${general}/followers/${made.webhook_id}`)).code).toBe(50013);
    expect(call("mod", "DELETE", `/channels/${general}/followers/${made.webhook_id}`)).toBeUndefined();
    expect(errorOf(() => call("mod", "DELETE", `/channels/${general}/followers/${made.webhook_id}`)).status).toBe(404);
    const again = follow("mod", news, general);
    expect(again.webhook_id).not.toBe(made.webhook_id);
    call("owner", "DELETE", `/channels/${general}`);
    expect(db.followers.size).toBe(0);
  });

  it("announcement messages start type 10 threads, and a sender joins the thread", () => {
    const m = say("owner", news, "discuss");
    const thread = startFrom("plain", news, m.id, "discussion");
    expect(thread.type).toBe(ChannelType.AnnouncementThread);
    addMessage({ channel: db.channels.get(thread.id)!, author_id: ids.other!, content: "hi", silent: true });
    expect(((call("plain", "GET", `/channels/${thread.id}/thread-members`) as ThreadMember[]).map(t => t.user_id))).toContain(ids.other);
  });
});
