import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("./rest", () => ({ request: vi.fn(), resolveUrl: (url: string) => url, listActiveThreads: vi.fn() }));

import { useLocalState } from "../shell/localState";
import { appStore } from "./store";
import { ChannelType, MessageType, type Channel, type Message, type ReadyEvent } from "./types";

const fire = (t: string, d: unknown): void => handlers.get(t)?.forEach(fn => fn(d));

const ME = "10";
const OTHER = "11";
const GUILD = "100";
const CATEGORY = "199";
const CHANNEL = "200";
const THREAD = "300";
const ROLE = "555";
const user = (id: string) => ({ id, username: `u${id}`, global_name: null, avatar: null, banner_color: null, bio: null, bot: false });
const channel = (extra: Partial<Channel>): Channel => ({ id: CHANNEL, type: ChannelType.GuildText, guild_id: GUILD, name: "general", topic: null, position: 0, parent_id: CATEGORY, last_message_id: null, ...extra });
const message = (channelId: string, id: string, extra: Partial<Message> = {}): Message => ({
  id,
  channel_id: channelId,
  guild_id: GUILD,
  author: user(OTHER),
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
  tts: false,
  message_reference: null,
  referenced_message: null,
  nonce: null,
  ...extra,
});
const ready = {
  v: 1,
  user: user(ME),
  session_id: "s",
  guilds: [
    {
      id: GUILD,
      name: "g",
      icon: null,
      owner_id: ME,
      roles: [],
      system_channel_id: null,
      channels: [channel({ id: CATEGORY, type: ChannelType.GuildCategory, name: "cat", parent_id: null }), channel({})],
      members: [{ user: user(ME), nick: null, roles: [ROLE], joined_at: "2026-01-01T00:00:00.000Z" }],
      member_count: 1,
      threads: [channel({ id: THREAD, type: ChannelType.PublicThread, parent_id: CHANNEL })],
    },
  ],
  private_channels: [],
  presences: [],
  read_states: [],
  relationships: [],
  guild_layout: { guild_folders: [], guild_positions: [] },
} as unknown as ReadyEvent;

const mentions = (id: string): number => appStore.getState().readStates[id]?.mention_count ?? 0;
const byName = [user(ME)] as unknown as Message["mentions"];
const everyone = (id: string, to = CHANNEL) => fire("MESSAGE_CREATE", message(to, id, { mention_everyone: true }));
const role = (id: string, to = CHANNEL) => fire("MESSAGE_CREATE", message(to, id, { content: `<@&${ROLE}> ping` }));

beforeEach(() => {
  useLocalState.setState({ suppressEveryone: {}, suppressRoles: {} });
  appStore.getState().reset();
  appStore.getState().applyReady(ready);
});

describe("unread mention counter", () => {
  it("counts my name, @everyone and my role", () => {
    fire("MESSAGE_CREATE", message(CHANNEL, "1", { mentions: byName }));
    everyone("2");
    role("3");
    expect(mentions(CHANNEL)).toBe(3);
  });

  it("skips @everyone where it is suppressed (channel, category or server) but not a role mention", () => {
    for (const scope of [CHANNEL, CATEGORY, GUILD]) {
      useLocalState.setState({ suppressEveryone: { [scope]: true } });
      everyone(`1${scope}`);
    }
    expect(mentions(CHANNEL)).toBe(0);
    role("2");
    expect(mentions(CHANNEL)).toBe(1);
  });

  it("skips my role where roles are suppressed, and a direct mention in the same message still counts", () => {
    useLocalState.setState({ suppressRoles: { [GUILD]: true }, suppressEveryone: { [GUILD]: true } });
    role("1");
    expect(mentions(CHANNEL)).toBe(0);
    fire("MESSAGE_CREATE", message(CHANNEL, "2", { mention_everyone: true, mentions: byName }));
    expect(mentions(CHANNEL)).toBe(1);
  });

  it("ignores a role I do not have", () => {
    fire("MESSAGE_CREATE", message(CHANNEL, "1", { content: "<@&999>" }));
    expect(mentions(CHANNEL)).toBe(0);
  });

  it("applies the same rules in threads, through the parent channel's category", () => {
    everyone("1", THREAD);
    role("2", THREAD);
    expect(mentions(THREAD)).toBe(2);
    useLocalState.setState({ suppressEveryone: { [CATEGORY]: true } });
    everyone("3", THREAD);
    expect(mentions(THREAD)).toBe(2);
  });
});
