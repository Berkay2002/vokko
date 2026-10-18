import { describe, expect, it } from "vitest";
import { guildUnread, type AppState } from "./store";
import { ChannelType, type Channel } from "./types";

const ch = (id: string, parent_id: string | null = null, type = ChannelType.GuildText): Channel => ({ id, type, guild_id: "g", name: id, parent_id, last_message_id: "9" }) as Channel;

const state = (channels: Channel[], mentions: Record<string, number> = {}, threads: Channel[] = []) =>
  ({
    channels: Object.fromEntries(channels.map(c => [c.id, c])),
    threads: Object.fromEntries(threads.map(c => [c.id, c])),
    readStates: Object.fromEntries(Object.entries(mentions).map(([id, mention_count]) => [id, { id, last_message_id: "1", mention_count }])),
  }) as unknown as AppState;

const thread = (id: string, parent_id: string, extra: Partial<Channel> = {}): Channel =>
  ({ id, type: ChannelType.PublicThread, guild_id: "g", name: id, parent_id, last_message_id: "9", member: { id, user_id: "me", join_timestamp: "", flags: 0, muted: false, mute_config: null }, ...extra }) as Channel;

describe("guildUnread with mutes", () => {
  const cat = { ...ch("cat", null, ChannelType.GuildCategory), last_message_id: null } as Channel;

  it("a muted channel drops out of the unread pill but keeps its mentions", () => {
    const s = state([ch("a")], { a: 2 });
    expect(guildUnread(s, "g")).toEqual({ unread: true, mentions: 2 });
    expect(guildUnread(s, "g", id => id === "a")).toEqual({ unread: false, mentions: 2 });
  });

  it("a channel in a muted category is quiet; an unmuted sibling still lights it", () => {
    const s = state([cat, ch("a", "cat"), ch("b")]);
    expect(guildUnread(s, "g", id => id === "cat").unread).toBe(true);
    expect(guildUnread(s, "g", id => id === "cat" || id === "b").unread).toBe(false);
  });
});

describe("guildUnread with threads", () => {
  const cat = { ...ch("cat", null, ChannelType.GuildCategory), last_message_id: null } as Channel;
  const read = (parent: Channel) => ({ ...parent, last_message_id: "1" }) as Channel;

  it("a joined thread with an unread message or a mention lights the guild, though its channel is read", () => {
    const s = state([read(ch("a"))], { a: 0, t: 2 }, [thread("t", "a")]);
    expect(guildUnread(s, "g")).toEqual({ unread: true, mentions: 2 });
  });

  it("a thread without a read state, an archived one and a thread that is not joined count as read", () => {
    const archived = thread("x", "a", { thread_metadata: { archived: true } as Channel["thread_metadata"] });
    const stranger = thread("y", "a", { member: undefined });
    const s = state([read(ch("a"))], { a: 0, x: 0, y: 0 }, [thread("t", "a"), archived, stranger]);
    expect(guildUnread(s, "g")).toEqual({ unread: false, mentions: 0 });
  });

  it("a muted parent channel, category, or the thread's own mute hides the thread's dot but keeps its mentions", () => {
    const s = state([cat, read(ch("a", "cat"))], { a: 0, t: 1 }, [thread("t", "a")]);
    expect(guildUnread(s, "g", id => id === "a")).toEqual({ unread: false, mentions: 1 });
    expect(guildUnread(s, "g", id => id === "cat")).toEqual({ unread: false, mentions: 1 });
    const own = state([cat, read(ch("a", "cat"))], { a: 0, t: 0 }, [thread("t", "a", { member: { id: "t", user_id: "me", join_timestamp: "", flags: 0, muted: true, mute_config: { end_time: null } } as Channel["member"] })]);
    expect(guildUnread(own, "g").unread).toBe(false);
  });
});
