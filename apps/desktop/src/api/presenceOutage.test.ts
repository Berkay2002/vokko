import { beforeEach, describe, expect, it } from "vitest";
import { appStore, applyConnection } from "./store";
import type { Presence, User } from "./types";

const presence = (user_id: string, status: Presence["status"] = "online"): Presence => ({ user_id, status, custom_status: null, activities: [] });

describe("presence while the gateway is down", () => {
  beforeEach(() => {
    appStore.setState({ connection: "ready", me: { id: "me" } as User, presences: { me: presence("me", "dnd"), alice: presence("alice"), bob: presence("bob", "idle") } });
  });

  it("hides others' presence on a drop and keeps the user's own", () => {
    applyConnection("reconnecting");
    expect(appStore.getState().presences).toEqual({ me: presence("me", "dnd") });
  });

  it("brings the kept presences back on RESUMED, under anything replayed", () => {
    applyConnection("reconnecting");
    applyConnection("connecting");
    appStore.setState({ presences: { ...appStore.getState().presences, bob: presence("bob", "offline") } });
    applyConnection("ready");
    expect(appStore.getState().presences).toEqual({ me: presence("me", "dnd"), alice: presence("alice"), bob: presence("bob", "offline") });
  });
});
