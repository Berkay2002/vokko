import { describe, expect, it, vi } from "vitest";

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
import type { User } from "./types";

const fire = (t: string, d: unknown): void => handlers.get(t)?.forEach(fn => fn(d));

describe("USER_UPDATE", () => {
  it("replaces another user's cached profile when only perk fields change", () => {
    const b = { id: "9", username: "bee", global_name: null, avatar: null, pronouns: "they/them" } as unknown as User;
    appStore.setState({ users: { "9": b } });
    fire("USER_UPDATE", { ...b, pronouns: "she/her" });
    expect(appStore.getState().users["9"]).toMatchObject({ pronouns: "she/her" });
  });
});
