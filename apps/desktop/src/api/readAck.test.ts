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

import { appStore } from "./store";
import { ChannelType, type Channel } from "./types";
import { dockBadgeLabel, summarizeUnread } from "../notify/badge";

const fire = (t: string, d: unknown): void => handlers.get(t)?.forEach(fn => fn(d));
const local = { mutedUntil: {}, notify: {}, suppressEveryone: {}, suppressRoles: {} };
const badge = () => dockBadgeLabel(summarizeUnread(appStore.getState(), local, Date.now()));

const GENERAL = "200";
const DM = "300";

beforeEach(() => {
  appStore.getState().reset();
  appStore.setState({
    channels: {
      [GENERAL]: { id: GENERAL, type: ChannelType.GuildText, guild_id: "100", name: "general", last_message_id: "500" } as Channel,
      [DM]: { id: DM, type: ChannelType.DM, last_message_id: "600", recipients: [] } as unknown as Channel,
    },
    readStates: {
      [GENERAL]: { channel_id: GENERAL, last_message_id: "400", mention_count: 2 },
      [DM]: { channel_id: DM, last_message_id: "550", mention_count: 1 },
    },
  });
});

describe("MESSAGE_ACK from another device", () => {
  it("clears the channel's share of the Dock badge once it is read up to the newest message", () => {
    expect(badge()).toBe("3");
    fire("MESSAGE_ACK", { channel_id: GENERAL, message_id: "500" });
    expect(appStore.getState().readStates[GENERAL]).toEqual({ channel_id: GENERAL, last_message_id: "500", mention_count: 0 });
    expect(badge()).toBe("1");
    fire("MESSAGE_ACK", { channel_id: DM, message_id: "600" });
    expect(badge()).toBeUndefined();
  });

  it("keeps the mentions of an ack that has not caught up (as the server does)", () => {
    fire("MESSAGE_ACK", { channel_id: DM, message_id: "580" });
    expect(appStore.getState().readStates[DM]).toEqual({ channel_id: DM, last_message_id: "580", mention_count: 1 });
    expect(badge()).toBe("3");
  });

  it("never moves the read pointer back", () => {
    fire("MESSAGE_ACK", { channel_id: GENERAL, message_id: "300" });
    expect(appStore.getState().readStates[GENERAL]?.last_message_id).toBe("400");
  });
});
