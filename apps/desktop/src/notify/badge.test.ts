import { describe, expect, it } from "vitest";
import { ChannelType, type Channel, type ReadState } from "../api/types";
import { faviconSvg, formatTitle, pageLabel, summarizeUnread } from "./badge";
import type { NotifyLocalState } from "./decide";
import { notificationTitle, plainBody } from "./text";

const NOW = 5_000_000;
const local = (patch: Partial<NotifyLocalState> = {}): NotifyLocalState => ({ mutedUntil: {}, notify: {}, suppressEveryone: {}, suppressRoles: {}, ...patch });
const channel = (id: string, patch: Partial<Channel> = {}): Channel =>
  ({ id, type: ChannelType.GuildText, guild_id: "g1", name: `chan-${id}`, topic: null, position: 0, parent_id: null, last_message_id: "50", ...patch }) as Channel;
const read = (channel_id: string, last_message_id: string | null, mention_count = 0): ReadState => ({ channel_id, last_message_id, mention_count });

describe("summarizeUnread", () => {
  it("counts mentions and flags unread channels", () => {
    const state = { channels: { a: channel("a"), b: channel("b") }, readStates: { a: read("a", "10", 2), b: read("b", "50", 0) } };
    expect(summarizeUnread(state, local(), NOW)).toEqual({ mentions: 2, unread: true });
  });

  it("is quiet when everything is read", () => {
    const state = { channels: { a: channel("a") }, readStates: { a: read("a", "50") } };
    expect(summarizeUnread(state, local(), NOW)).toEqual({ mentions: 0, unread: false });
  });

  it("ignores muted channels (own, category or guild), 'Nothing' channels and voice channels", () => {
    const channels = { a: channel("a"), b: channel("b", { parent_id: "cat" }), c: channel("c"), v: channel("v", { type: ChannelType.GuildVoice }) };
    const readStates = { a: read("a", "1", 1), b: read("b", "1", 1), c: read("c", "1", 1), v: read("v", "1", 1) };
    const muted = local({ mutedUntil: { a: -1, cat: NOW + 1000 }, notify: { c: "none" } });
    expect(summarizeUnread({ channels, readStates }, muted, NOW)).toEqual({ mentions: 0, unread: false });
    // an expired mute counts again
    expect(summarizeUnread({ channels: { a: channels.a }, readStates }, local({ mutedUntil: { a: NOW - 1 } }), NOW)).toEqual({ mentions: 1, unread: true });
  });

  it("'only mentions' channels count mentions but never the plain unread dot", () => {
    const state = { channels: { a: channel("a") }, readStates: { a: read("a", "1", 0) } };
    expect(summarizeUnread(state, local({ notify: { a: "mentions" } }), NOW)).toEqual({ mentions: 0, unread: false });
  });

  it("a channel without any read state is unread", () => {
    expect(summarizeUnread({ channels: { a: channel("a") }, readStates: {} }, local(), NOW).unread).toBe(true);
  });
});

describe("title and page label", () => {
  it("formats like Discord: (N) with mentions, bullet with unread", () => {
    expect(formatTitle("Vokko", { mentions: 0, unread: false })).toBe("Vokko");
    expect(formatTitle("Vokko", { mentions: 0, unread: true }, "#general | Lab")).toBe("• Vokko | #general | Lab");
    expect(formatTitle("Vokko", { mentions: 3, unread: true }, "@alice")).toBe("(3) Vokko | @alice");
    expect(formatTitle("Vokko", { mentions: 250, unread: true })).toBe("(99+) Vokko");
  });

  it("names the page from the route", () => {
    const me = { id: "1" } as never;
    const channels = { a: channel("a", { name: "general" }), d: { ...channel("d"), type: ChannelType.DM, guild_id: null, name: null, recipients: [{ id: "2", username: "alice", global_name: null }] } as unknown as Channel };
    const guilds = { g1: { id: "g1", name: "Lab" } } as never;
    const base = { me, channels, guilds };
    expect(pageLabel({ ...base, route: { guildId: "g1", channelId: "a" } })).toBe("#general | Lab");
    expect(pageLabel({ ...base, route: { guildId: null, channelId: "d" } })).toBe("@alice");
    expect(pageLabel({ ...base, route: { guildId: null, channelId: null } })).toBe("Friends");
    expect(pageLabel({ ...base, me: null, route: { guildId: null, channelId: null } })).toBeNull();
  });

  it("favicon svg carries the badge only when there is something to show", () => {
    expect(faviconSvg({ mentions: 0, unread: false })).not.toContain("#f23f42");
    expect(faviconSvg({ mentions: 0, unread: true })).toContain("#f23f42");
    expect(faviconSvg({ mentions: 12, unread: true })).toContain("9+");
  });
});

describe("notification text", () => {
  const names = { userName: (id: string) => (id === "2" ? "Alice" : null), roleName: (id: string) => (id === "9" ? "mods" : null), channelNameOf: (id: string) => (id === "7" ? "general" : null) };

  it("resolves mentions, custom emoji and spoilers to plain text", () => {
    const body = plainBody({ content: "hi <@2> <@&9> in <#7> <:wave:123> ||secret||", attachments: [], embeds: [] }, names);
    expect(body).toBe("hi @Alice @mods in #general :wave: [spoiler]");
  });

  it("describes attachment-only messages and truncates long text", () => {
    expect(plainBody({ content: "", attachments: [{}] as never, embeds: [] }, names)).toBe("Sent an attachment");
    expect(plainBody({ content: "", attachments: [{}, {}] as never, embeds: [] }, names)).toBe("Sent 2 attachments");
    const long = plainBody({ content: "x".repeat(500), attachments: [], embeds: [] }, names);
    expect(long.length).toBe(200);
    expect(long.endsWith("…")).toBe(true);
  });

  it("titles name the channel and server for guild messages", () => {
    expect(notificationTitle({ authorName: "alice", channelName: "general", guildName: "Lab", group: false })).toBe("alice (#general, Lab)");
    expect(notificationTitle({ authorName: "alice", channelName: "Movie night", guildName: null, group: true })).toBe("alice (Movie night)");
    expect(notificationTitle({ authorName: "alice", channelName: "alice", guildName: null, group: false })).toBe("alice");
  });
});
