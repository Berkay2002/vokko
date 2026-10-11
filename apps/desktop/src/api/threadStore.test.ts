import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, ((d: unknown) => void)[]>());
vi.mock("./gateway", () => ({
  gateway: {
    on: (t: string, fn: (d: unknown) => void) => {
      handlers.set(t, [...(handlers.get(t) ?? []), fn]);
      return () => undefined;
    },
    onStatus: () => () => undefined,
  },
}));
const listActiveThreads = vi.hoisted(() => vi.fn());
vi.mock("./rest", () => ({ request: vi.fn(), resolveUrl: (url: string) => url, listActiveThreads }));

import { appStore } from "./store";
import { ChannelType, MessageType, type Channel, type Message, type ReadyEvent } from "./types";

const fire = (t: string, d: unknown): void => handlers.get(t)?.forEach(fn => fn(d));

const ME = "10";
const GUILD = "100";
const PARENT = "200";
const user = { id: ME, username: "me", global_name: null, avatar: null, banner_color: null, bio: null, bot: false };
const thread = (id: string, extra: Partial<Channel> = {}): Channel => ({
  id,
  type: ChannelType.PublicThread,
  guild_id: GUILD,
  name: `thread ${id}`,
  topic: null,
  position: 0,
  parent_id: PARENT,
  last_message_id: null,
  owner_id: ME,
  message_count: 0,
  member_count: 1,
  thread_metadata: { archived: false, auto_archive_duration: 1440, archive_timestamp: "2026-01-01T00:00:00.000Z", locked: false },
  ...extra,
});
const member = (id: string, userId = ME) => ({ id, user_id: userId, join_timestamp: "2026-01-01T00:00:00.000Z", flags: 0 });
const message = (channelId: string, id: string, extra: Partial<Message> = {}): Message => ({
  id,
  channel_id: channelId,
  guild_id: GUILD,
  author: user,
  content: "hi",
  timestamp: "2026-01-01T00:00:00.000Z",
  edited_timestamp: null,
  type: MessageType.Default,
  mentions: [],
  mention_everyone: false,
  attachments: [],
  embeds: [],
  reactions: [],
  pinned: false,
  message_reference: null,
  referenced_message: null,
  nonce: null,
  ...extra,
});
const ready = (threads: Channel[]): ReadyEvent => ({
  v: 1,
  user,
  session_id: "s",
  guilds: [
    {
      id: GUILD,
      name: "g",
      icon: null,
      owner_id: ME,
      roles: [],
      system_channel_id: null,
      channels: [{ id: PARENT, type: ChannelType.GuildText, guild_id: GUILD, name: "general", topic: null, position: 0, parent_id: null, last_message_id: null }],
      members: [{ user, nick: null, roles: [], joined_at: "2026-01-01T00:00:00.000Z" }],
      member_count: 1,
      threads,
    },
  ],
  private_channels: [],
  presences: [],
  read_states: [],
  relationships: [],
});

beforeEach(() => {
  appStore.getState().reset();
  appStore.getState().applyReady(ready([thread("1", { member: member("1") })]));
});
afterEach(() => vi.useRealTimers());

describe("threads in the store", () => {
  it("READY and GUILD_CREATE fill `threads`, never `channels` or the guild", () => {
    const state = appStore.getState();
    expect(Object.keys(state.threads)).toEqual(["1"]);
    expect(state.channels["1"]).toBeUndefined();
    expect("threads" in (state.guilds[GUILD] ?? {})).toBe(false);
    fire("GUILD_CREATE", { ...ready([]).guilds[0]!, id: "101", threads: [thread("2", { guild_id: "101" })] });
    expect(Object.keys(appStore.getState().threads).sort()).toEqual(["1", "2"]);
    appStore.getState().removeGuild("101");
    expect(Object.keys(appStore.getState().threads)).toEqual(["1"]);
  });

  it("THREAD_CREATE, THREAD_UPDATE and THREAD_DELETE; an update without a membership keeps ours", () => {
    fire("THREAD_CREATE", thread("3"));
    expect(appStore.getState().threads["3"]?.name).toBe("thread 3");
    fire("THREAD_UPDATE", { ...thread("1"), name: "renamed", thread_metadata: { ...thread("1").thread_metadata!, archived: true } });
    expect(appStore.getState().threads["1"]).toMatchObject({ name: "renamed", member: { user_id: ME } });
    expect(appStore.getState().threads["1"]?.thread_metadata?.archived).toBe(true);
    fire("THREAD_DELETE", { id: "3", guild_id: GUILD, parent_id: PARENT, type: ChannelType.PublicThread });
    expect(appStore.getState().threads["3"]).toBeUndefined();
  });

  it("THREAD_MEMBER_UPDATE joins, THREAD_MEMBERS_UPDATE changes the count and removes our membership", () => {
    fire("THREAD_CREATE", thread("4"));
    fire("THREAD_MEMBER_UPDATE", { ...member("4"), guild_id: GUILD });
    expect(appStore.getState().threads["4"]?.member?.user_id).toBe(ME);
    fire("THREAD_MEMBERS_UPDATE", { id: "4", guild_id: GUILD, member_count: 3, added_members: [member("4", "11")] });
    expect(appStore.getState().threads["4"]).toMatchObject({ member_count: 3, member: { user_id: ME } });
    fire("THREAD_MEMBERS_UPDATE", { id: "4", guild_id: GUILD, member_count: 2, removed_member_ids: [ME] });
    expect(appStore.getState().threads["4"]?.member).toBeUndefined();
    expect(appStore.getState().threads["4"]?.member_count).toBe(2);
  });

  it("leaving a private thread removes it (and asks the server what is still visible)", () => {
    vi.useFakeTimers();
    listActiveThreads.mockResolvedValue({ threads: [], members: [], has_more: false });
    fire("THREAD_CREATE", thread("5", { type: ChannelType.PrivateThread, member: member("5") }));
    fire("THREAD_MEMBERS_UPDATE", { id: "5", guild_id: GUILD, member_count: 1, removed_member_ids: [ME] });
    expect(appStore.getState().threads["5"]).toBeUndefined();
    vi.advanceTimersByTime(200);
    expect(listActiveThreads).toHaveBeenCalledWith(GUILD);
  });

  it("messages in a thread update its counters and read state; the starter message is not counted", () => {
    fire("MESSAGE_CREATE", message("1", "50", { type: MessageType.ThreadStarterMessage }));
    expect(appStore.getState().threads["1"]).toMatchObject({ last_message_id: "50", message_count: 0 });
    fire("MESSAGE_CREATE", message("1", "51", { author: { ...user, id: "11" }, mentions: [user] }));
    expect(appStore.getState().threads["1"]).toMatchObject({ last_message_id: "51", message_count: 1 });
    expect(appStore.getState().readStates["1"]?.mention_count).toBe(1);
    fire("MESSAGE_CREATE", message("1", "52"));
    expect(appStore.getState().threads["1"]?.message_count).toBe(2);
    expect(appStore.getState().readStates["1"]).toMatchObject({ last_message_id: "52", mention_count: 0 });
    expect(appStore.getState().channels["1"]).toBeUndefined();
  });

  it("a change of our roles refetches the active threads and replaces the unarchived ones", async () => {
    vi.useFakeTimers();
    fire("THREAD_CREATE", thread("6", { thread_metadata: { ...thread("6").thread_metadata!, archived: true } }));
    listActiveThreads.mockResolvedValue({ threads: [thread("7")], members: [], has_more: false });
    fire("GUILD_MEMBER_UPDATE", { user, nick: null, roles: ["9"], joined_at: "2026-01-01T00:00:00.000Z", guild_id: GUILD });
    await vi.advanceTimersByTimeAsync(200);
    expect(Object.keys(appStore.getState().threads).sort()).toEqual(["6", "7"]); // "1" is no longer visible; the archived "6" stays
  });
});
