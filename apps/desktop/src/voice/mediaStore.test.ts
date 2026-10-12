// isStreaming: the webhook-fed self_stream stays the authority; a live screen share seen in our own call counts too.

import { beforeEach, describe, expect, it } from "vitest";
import type { VoiceState } from "../api/types";
import { isStreaming, resetMedia, setLiveScreen, useMedia } from "./mediaStore";

const state = (user_id: string, channel_id: string | null, self_stream = false): VoiceState =>
  ({ user_id, channel_id, guild_id: "1", session_id: "s", self_stream, self_video: false, self_mute: false, self_deaf: false, mute: false, deaf: false, suppress: false }) as unknown as VoiceState;

beforeEach(() => resetMedia());

describe("isStreaming", () => {
  it("is true when the webhook set self_stream, whatever the transport saw", () => {
    expect(isStreaming(state("2", "10", true), {}, "1", null, false)).toBe(true);
  });

  it("counts a screen share the transport sees live in the call we are in", () => {
    const live = { "2": true as const };
    expect(isStreaming(state("2", "10"), live, "1", "10", false)).toBe(true);
    expect(isStreaming(state("3", "10"), live, "1", "10", false)).toBe(false);
  });

  it("ignores the transport for users who are in another channel or have no state channel (ghost participants)", () => {
    const live = { "2": true as const };
    expect(isStreaming(state("2", "11"), live, "1", "10", false)).toBe(false);
    expect(isStreaming(state("2", null), live, "1", "10", false)).toBe(false);
    expect(isStreaming(state("2", "10"), live, "1", null, false)).toBe(false);
  });

  it("our own tile streams while our share is being published", () => {
    expect(isStreaming(state("1", "10"), {}, "1", "10", true)).toBe(true);
    expect(isStreaming(state("1", "10"), {}, "1", "10", false)).toBe(false);
  });
});

describe("setLiveScreen", () => {
  it("adds and removes without churning the store when nothing changed, and resetMedia clears it", () => {
    setLiveScreen("2", true);
    const before = useMedia.getState().liveScreens;
    setLiveScreen("2", true);
    expect(useMedia.getState().liveScreens).toBe(before);
    setLiveScreen("2", false);
    expect(useMedia.getState().liveScreens).toEqual({});
    setLiveScreen("3", true);
    resetMedia();
    expect(useMedia.getState().liveScreens).toEqual({});
  });
});
