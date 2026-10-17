import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { activitiesFor, useActivity } from "../activity";
import { appStore } from "../api/store";
import { OwnActivity } from "./UserPanelPopout";

const song = { name: "Spotify", type: 2 as const, details: "Midnight City", state: "M83", sync_id: "4uLU6hMCjMI75M1A2tKUQC" };

describe("OwnActivity in the user panel popout", () => {
  beforeEach(() => {
    appStore.setState({ presences: {} });
    useActivity.setState({ share: true, spotify: false, detected: null, listening: null });
  });

  it("renders nothing without an activity", () => {
    expect(renderToStaticMarkup(<OwnActivity userId="me" />)).toBe("");
  });

  it("shows the echoed presence song as a Spotify card", () => {
    appStore.setState({ presences: { me: { user_id: "me", status: "online", custom_status: null, activities: [song] } } });
    const html = renderToStaticMarkup(<OwnActivity userId="me" />);
    expect(html).toContain('data-testid="spotify-card"');
    expect(html).toContain("Midnight City");
  });

  it("sends the local song when it is shared (what the fallback renders)", () => {
    expect(activitiesFor({ share: true, spotify: true, listening: song, detected: null })).toEqual([song]);
    expect(activitiesFor({ share: true, spotify: false, listening: song, detected: null })).toEqual([]);
  });
});
