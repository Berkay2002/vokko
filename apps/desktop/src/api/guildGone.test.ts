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

import { useModals } from "../shell/modalStore";
import { appStore, selfRemoving } from "./store";
import type { Guild } from "./types";

const fire = (t: string, d: unknown): void => handlers.get(t)?.forEach(fn => fn(d));
const modal = () => useModals.getState().modal;

describe("GUILD_DELETE notice", () => {
  beforeEach(() => {
    useModals.setState({ modal: null, base: null });
    appStore.setState({ guilds: { "7": { id: "7", name: "Club" } as Guild }, guildOrder: ["7"] });
  });

  it("tells the user the server is gone, once", () => {
    fire("GUILD_DELETE", { id: "7" });
    expect(modal()).toMatchObject({ type: "guildGone", name: "Club" });
    expect(appStore.getState().guilds["7"]).toBeUndefined();
    useModals.setState({ modal: null, base: null });
    fire("GUILD_DELETE", { id: "7" }); // a repeat, or a resync that already dropped it
    expect(modal()).toBeNull();
  });

  it("stays quiet for a leave or delete this client started", () => {
    selfRemoving.add("7");
    fire("GUILD_DELETE", { id: "7" });
    selfRemoving.delete("7");
    expect(modal()).toBeNull();
    expect(appStore.getState().guilds["7"]).toBeUndefined();
  });
});
