import { describe, expect, it, vi } from "vitest";

vi.mock("../api/gateway", () => ({ gateway: { on: vi.fn() } }));
vi.mock("../api/store", () => ({ appStore: { getState: () => ({ channels: {}, threads: {}, me: { id: "me" } }) } }));
vi.mock("./api", () => ({ commandIndex: vi.fn(), invokeInteraction: vi.fn() }));

import { invalidateGuildIndexes, useAppsStore } from "./store";

const entry = { data: { applications: [], application_commands: [] }, loading: false, error: null };

describe("invalidateGuildIndexes", () => {
  it("drops only the indexes of that guild's channels", () => {
    useAppsStore.setState({ indexes: { a1: entry, a2: entry, b1: entry, dm: entry } });
    const guilds: Record<string, string | null> = { a1: "A", a2: "A", b1: "B", dm: null };
    invalidateGuildIndexes("A", id => guilds[id]);
    expect(Object.keys(useAppsStore.getState().indexes).sort()).toEqual(["b1", "dm"]);
  });
});
