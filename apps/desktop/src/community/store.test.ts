import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduledEventEntityType, ScheduledEventStatus, type GuildScheduledEvent } from "../api/types";

let answer: ((list: GuildScheduledEvent[]) => void) | null = null;
vi.mock("./shell", () => ({
  request: () => new Promise<GuildScheduledEvent[]>(resolve => (answer = resolve)),
  gateway: { on: () => undefined },
  appStore: { getState: () => ({ me: { id: "me" } }) },
}));

import { loadEvents, useCommunity, withBuffered } from "./store";

const event = (id: string, name: string, hours: number, status = ScheduledEventStatus.Scheduled): GuildScheduledEvent => ({
  id,
  guild_id: "g1",
  channel_id: null,
  creator_id: "u1",
  name,
  description: null,
  scheduled_start_time: new Date(Date.UTC(2030, 0, 1, hours)).toISOString(),
  scheduled_end_time: null,
  privacy_level: 2,
  status,
  entity_type: ScheduledEventEntityType.External,
  entity_id: null,
  entity_metadata: { location: "x" },
  user_count: 0,
  user_rsvp: false,
  image: null,
  recurrence_rule: null,
});

beforeEach(() => {
  useCommunity.getState().clear();
  answer = null;
});

describe("events that arrive while the first list is loading", () => {
  it("are laid over the response instead of being dropped", async () => {
    const pending = loadEvents("g1");
    const store = useCommunity.getState();
    // a create, an update of a listed event and a removal, all before the response lands
    store.upsert(event("3", "Created meanwhile", 3));
    store.upsert(event("1", "Renamed meanwhile", 1));
    store.remove("g1", "2");
    answer!([event("1", "Old name", 1), event("2", "Deleted meanwhile", 2)]);
    await pending;
    const state = useCommunity.getState();
    expect(state.loaded.g1).toBe(true);
    expect(state.events.g1!.map(e => e.name)).toEqual(["Renamed meanwhile", "Created meanwhile"]);
  });

  it("do not stay buffered once the list has loaded", async () => {
    const pending = loadEvents("g1");
    answer!([event("1", "One", 1)]);
    await pending;
    useCommunity.getState().upsert(event("2", "Later", 2));
    expect(useCommunity.getState().events.g1!.map(e => e.name)).toEqual(["One", "Later"]);
    useCommunity.getState().remove("g1", "1");
    expect(useCommunity.getState().events.g1!.map(e => e.name)).toEqual(["Later"]);
  });
});

describe("withBuffered", () => {
  it("lets a later change win over the fetched copy and drops finished events", () => {
    const list = [event("1", "a", 1), event("2", "b", 2)];
    const changes = new Map<string, GuildScheduledEvent | null>([["1", event("1", "a2", 1, ScheduledEventStatus.Completed)], ["2", event("2", "b2", 2)]]);
    expect(withBuffered(list, changes).map(e => e.name)).toEqual(["b2"]);
    expect(withBuffered(list, undefined).map(e => e.name)).toEqual(["a", "b"]);
  });
});
