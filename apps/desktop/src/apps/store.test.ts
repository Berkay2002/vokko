import { afterEach, describe, expect, it, vi } from "vitest";

const handlers: Record<string, (data: unknown) => void> = {};
vi.mock("../api/gateway", () => ({ gateway: { on: (type: string, fn: (data: unknown) => void) => void (handlers[type] = fn) } }));
vi.mock("../api/store", () => ({ appStore: { getState: () => ({ channels: {}, threads: {}, me: { id: "me" } }) } }));
vi.mock("./api", () => ({ commandIndex: vi.fn(), invokeInteraction: vi.fn() }));

import { ComponentType } from "../api/types";
import { invokeInteraction } from "./api";
import { clickComponent, invalidateGuildIndexes, useAppsStore } from "./store";

const entry = { data: { applications: [], application_commands: [] }, loading: false, error: null };

describe("invalidateGuildIndexes", () => {
  it("drops only the indexes of that guild's channels", () => {
    useAppsStore.setState({ indexes: { a1: entry, a2: entry, b1: entry, dm: entry } });
    const guilds: Record<string, string | null> = { a1: "A", a2: "A", b1: "B", dm: null };
    invalidateGuildIndexes("A", id => guilds[id]);
    expect(Object.keys(useAppsStore.getState().indexes).sort()).toEqual(["b1", "dm"]);
  });
});

describe("clickComponent", () => {
  const message = { id: "m1", channel_id: "c1", application_id: "app" };
  const click = () => useAppsStore.getState().clicks.m1;
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(invokeInteraction).mockReset();
    useAppsStore.setState({ clicks: {} });
  });

  it("sends the click, waits for the app, and INTERACTION_SUCCESS ends the wait", async () => {
    vi.useFakeTimers();
    vi.mocked(invokeInteraction).mockResolvedValue({ id: "i1", nonce: null });
    clickComponent(message, "go", ComponentType.StringSelect, ["a"]);
    expect(click()?.state).toBe("sending");
    expect(vi.mocked(invokeInteraction).mock.calls[0]?.[0]).toMatchObject({ type: 3, application_id: "app", channel_id: "c1", message_id: "m1", data: { custom_id: "go", component_type: 3, values: ["a"] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(click()?.state).toBe("waiting");
    clickComponent(message, "go", ComponentType.Button);
    expect(invokeInteraction).toHaveBeenCalledTimes(1);
    handlers.INTERACTION_SUCCESS?.({ id: "i1", nonce: click()?.nonce });
    expect(click()).toBeUndefined();
  });

  it("fails on INTERACTION_FAILURE, on a refused request and after a silent timeout, and a later click goes through", async () => {
    vi.useFakeTimers();
    vi.mocked(invokeInteraction).mockResolvedValue({ id: "i1", nonce: null });
    clickComponent(message, "go", ComponentType.Button);
    await vi.advanceTimersByTimeAsync(0);
    handlers.INTERACTION_FAILURE?.({ id: "i1", nonce: click()?.nonce });
    expect(click()?.state).toBe("failed");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(click()).toBeUndefined();

    vi.mocked(invokeInteraction).mockRejectedValue(new Error("no"));
    clickComponent(message, "go", ComponentType.Button);
    await vi.advanceTimersByTimeAsync(0);
    expect(click()?.state).toBe("failed");
    vi.mocked(invokeInteraction).mockResolvedValue({ id: "i2", nonce: null });
    clickComponent(message, "go", ComponentType.Button);
    await vi.advanceTimersByTimeAsync(0);
    expect(click()?.state).toBe("waiting");
    await vi.advanceTimersByTimeAsync(16_000);
    expect(click()?.state).toBe("failed");
  });
});
