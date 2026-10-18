import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStore, applyConnection, BANNER_GRACE_MS } from "./store";
import type { Presence, User } from "./types";

const presence = (user_id: string, status: Presence["status"] = "online"): Presence => ({ user_id, status, custom_status: null, activities: [] });
const all = { me: presence("me", "dnd"), alice: presence("alice"), bob: presence("bob", "idle") };

describe("presence while the gateway is down", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    appStore.setState({ connection: "ready", me: { id: "me" } as User, presences: all });
  });
  afterEach(() => {
    applyConnection("ready");
    vi.useRealTimers();
  });

  it("keeps presences through a blip shorter than the banner grace", () => {
    applyConnection("reconnecting");
    vi.advanceTimersByTime(BANNER_GRACE_MS - 100);
    expect(appStore.getState().presences).toEqual(all);
    applyConnection("ready");
    vi.advanceTimersByTime(BANNER_GRACE_MS);
    expect(appStore.getState().presences).toEqual(all);
  });

  it("hides others' presence once an outage outlasts the grace and keeps the user's own", () => {
    applyConnection("reconnecting");
    applyConnection("connecting");
    vi.advanceTimersByTime(BANNER_GRACE_MS);
    expect(appStore.getState().presences).toEqual({ me: presence("me", "dnd") });
  });

  it("brings the kept presences back on RESUMED, under anything replayed", () => {
    applyConnection("reconnecting");
    vi.advanceTimersByTime(BANNER_GRACE_MS);
    applyConnection("connecting");
    appStore.setState({ presences: { ...appStore.getState().presences, bob: presence("bob", "offline") } });
    applyConnection("ready");
    expect(appStore.getState().presences).toEqual({ me: presence("me", "dnd"), alice: presence("alice"), bob: presence("bob", "offline") });
  });
});
