import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChannelType, ScheduledEventEntityType, ScheduledEventStatus, type Channel, type GuildScheduledEvent } from "../api/types";
import { JoinEventButton } from "./EventCard";
import { joinLabel } from "./eventUtil";
import { appStore } from "./shell";

const event = (over: Partial<GuildScheduledEvent>): GuildScheduledEvent =>
  ({ id: "5", guild_id: "1", channel_id: "9", status: ScheduledEventStatus.Active, entity_type: ScheduledEventEntityType.StageInstance, ...over }) as GuildScheduledEvent;

describe("joinLabel", () => {
  it("names the join action of a live stage or voice event", () => {
    expect(joinLabel(event({}))).toBe("Join Stage");
    expect(joinLabel(event({ entity_type: ScheduledEventEntityType.Voice }))).toBe("Join Voice");
  });

  it("offers nothing before the event is live, after it, or without a channel", () => {
    expect(joinLabel(event({ status: ScheduledEventStatus.Scheduled }))).toBeNull();
    expect(joinLabel(event({ status: ScheduledEventStatus.Completed }))).toBeNull();
    expect(joinLabel(event({ entity_type: ScheduledEventEntityType.External, channel_id: null }))).toBeNull();
    expect(joinLabel(event({ channel_id: null }))).toBeNull();
  });
});

describe("JoinEventButton", () => {
  it("renders the button only while the event is live and its channel is known", () => {
    appStore.setState({ channels: { "9": { id: "9", guild_id: "1", type: ChannelType.GuildStage, name: "town-hall" } as Channel } });
    expect(renderToStaticMarkup(<JoinEventButton event={event({})} />)).toContain("Join Stage");
    expect(renderToStaticMarkup(<JoinEventButton event={event({ entity_type: ScheduledEventEntityType.Voice })} />)).toContain("Join Voice");
    expect(renderToStaticMarkup(<JoinEventButton event={event({ status: ScheduledEventStatus.Scheduled })} />)).toBe("");
    expect(renderToStaticMarkup(<JoinEventButton event={event({ channel_id: "404" })} />)).toBe("");
  });
});
