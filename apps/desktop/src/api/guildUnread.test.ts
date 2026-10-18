import { describe, expect, it } from "vitest";
import { guildUnread, type AppState } from "./store";
import { ChannelType, type Channel } from "./types";

const ch = (id: string, parent_id: string | null = null, type = ChannelType.GuildText): Channel => ({ id, type, guild_id: "g", name: id, parent_id, last_message_id: "9" }) as Channel;

const state = (channels: Channel[], mentions: Record<string, number> = {}) =>
  ({
    channels: Object.fromEntries(channels.map(c => [c.id, c])),
    readStates: Object.fromEntries(Object.entries(mentions).map(([id, mention_count]) => [id, { id, last_message_id: "1", mention_count }])),
  }) as unknown as AppState;

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
