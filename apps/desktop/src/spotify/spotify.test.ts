import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../api/rest";
import type { SpotifyState } from "../api/types";
import type { NowPlaying } from "../desktop/spotify";
import { playsInCall, spotifyActivity } from "../activity/spotify";
import { voiceReducer, initialVoiceModel } from "../voice/reducer";
import { artUrl, conflictOf, shownPositionMs, statusText } from "./format";
import { currentView, initialPanel, panelReducer } from "./panelState";

const ART = "ab67616d00001e02e0f5c2a1b3d4e5f60718293a";
const TRACK = { uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC", title: "One More Time", artists: ["Daft Punk"], art: ART, duration_ms: 320_000, explicit: false };
const state = (over: Partial<SpotifyState> = {}): SpotifyState => ({
  status: "playing",
  track: TRACK,
  playing: true,
  position_ms: 10_000,
  updated_at_ms: 1_000,
  loop: "off",
  queue: [],
  queue_len: 0,
  can_previous: false,
  started_by: "1",
  bot_identity: "bot:spotify:9",
  host_id: "1",
  skip_votes: [],
  skip_needed: 1,
  ...over,
});

describe("Spotify panel navigation", () => {
  it("opens pages on top of the search, goes back, and a new query returns to the results", () => {
    let s = panelReducer(initialPanel, { type: "query", query: "daft" });
    s = panelReducer(s, { type: "tab", tab: "album" });
    s = panelReducer(s, { type: "open", kind: "album", id: "a", title: "Discovery" });
    s = panelReducer(s, { type: "open", kind: "artist", id: "b", title: "Daft Punk" });
    expect(currentView(s)).toMatchObject({ name: "page", kind: "artist" });
    s = panelReducer(s, { type: "back" });
    expect(currentView(s)).toMatchObject({ name: "page", kind: "album" });
    expect(panelReducer(s, { type: "query", query: "x" }).trail).toEqual([{ name: "search" }]);
    expect(s.tab).toBe("album");
    expect(panelReducer(initialPanel, { type: "back" })).toBe(initialPanel);
  });
});

describe("Spotify format helpers", () => {
  it("only ever builds i.scdn.co art URLs from a 40-hex id", () => {
    expect(artUrl(ART)).toBe(`https://i.scdn.co/image/${ART}`);
    expect(artUrl("https://evil.example/x.png")).toBeUndefined();
    expect(artUrl(undefined)).toBeUndefined();
  });

  it("moves the position with the clock only while playing, capped at the track's end", () => {
    expect(shownPositionMs(state(), 3_000)).toBe(12_000);
    expect(shownPositionMs(state({ playing: false, status: "paused" }), 3_000)).toBe(10_000);
    expect(shownPositionMs(state({ status: "loading" }), 3_000)).toBe(10_000);
    expect(shownPositionMs(state(), 10_000_000)).toBe(320_000);
    expect(shownPositionMs(state({ track: null }), 3_000)).toBe(0);
  });

  it("says what the tile is waiting for, and the server's fixed error text", () => {
    expect(statusText(state(), "connected")).toBe("");
    expect(statusText(state(), "connecting")).toBe("Connecting…");
    expect(statusText(state({ status: "starting" }), "connected")).toBe("Starting…");
    expect(statusText(state({ track: null, status: "paused" }), "connected")).toMatch(/Nothing left/);
    expect(statusText(state({ status: "error", error: "Playback failed." }), "connected")).toBe("Playback failed.");
  });

  it("recognises the two conflicts", () => {
    const busy = new ApiRequestError(409, { code: 40035, message: "Spotify is already playing in another call." });
    expect(conflictOf(busy)).toBe("Spotify is already playing in another call.");
    expect(conflictOf(new ApiRequestError(400, { code: 40033, message: "x" }))).toBeNull();
  });
});

describe("presence guard", () => {
  const local = (over: Partial<NowPlaying> = {}) =>
    spotifyActivity({ title: "One More Time", artists: ["Daft Punk"], album: "Discovery", track_id: "4uLU6hMCjMI75M1A2tKUQC", image_id: ART, position_ms: 0, duration_ms: 320_000, ...over }, 0)!;

  it("drops the local Spotify activity while a call session plays the same track (by id, else by title and artists)", () => {
    expect(playsInCall(local(), [TRACK])).toBe(true);
    expect(playsInCall(local({ track_id: "0000000000000000000000" }), [TRACK])).toBe(false);
    expect(playsInCall(local({ track_id: null }), [TRACK])).toBe(true);
    expect(playsInCall(local({ track_id: null, artists: ["Someone"] }), [TRACK])).toBe(false);
    expect(playsInCall(local(), [])).toBe(false);
  });
});

describe("voice store", () => {
  it("tracks the Spotify session from READY, SPOTIFY_UPDATE and channel deletes", () => {
    let m = voiceReducer(initialVoiceModel, { type: "ready", meId: "1", voiceEnabled: true, guilds: [{ id: "g", voice_states: [], spotify: [{ channel_id: "9", state: state() }] }] });
    expect(m.spotify["9"]?.track?.title).toBe("One More Time");
    m = voiceReducer(m, { type: "spotify", channelId: "9", state: state({ playing: false, status: "paused" }) });
    expect(m.spotify["9"]?.status).toBe("paused");
    expect(voiceReducer(m, { type: "channelDelete", channelId: "9" }).spotify).toEqual({});
    const ended = voiceReducer(m, { type: "spotify", channelId: "9", state: null });
    expect(ended.spotify).toEqual({});
    expect(voiceReducer(ended, { type: "spotify", channelId: "9", state: null })).toBe(ended);
  });
});
