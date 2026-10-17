import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../api/rest";
import type { SpotifySearchResults, SpotifyTrack } from "../api/types";
import { activityListIsValid } from "../api/mock/activities";
import type { NowPlaying } from "../desktop/spotify";
import { listeningActivity, shownActivity, spotifyImageUrl, spotifyOpenUrl } from "./format";
import { lookUpTrack, matchTrack, resetTrackLookups, sameSpotifyMoment, spotifyActivity, withCatalog } from "./spotify";

const IMAGE = "ab67616d00001e02e0f5c2a1b3d4e5f60718293a";
const track = (over: Partial<NowPlaying> = {}): NowPlaying => ({
  title: "Song",
  artists: ["A", "B"],
  album: "Album",
  track_id: "4uLU6hMCjMI75M1A2tKUQC",
  image_id: IMAGE,
  position_ms: 60_000,
  duration_ms: 200_000,
  ...over,
});

describe("spotifyActivity", () => {
  it("maps a playing track with art, track id and timestamps", () => {
    const activity = spotifyActivity(track(), 1_000_000);
    expect(activity).toEqual({
      name: "Spotify",
      type: 2,
      details: "Song",
      state: "A; B",
      assets: { large_image: `spotify:${IMAGE}` },
      sync_id: "4uLU6hMCjMI75M1A2tKUQC",
      timestamps: { start: 940_000, end: 1_140_000 },
    });
    expect(activityListIsValid([activity!])).toBe(true);
  });

  it("leaves out art and track id that are missing or not the exact shape (the Windows media session has neither)", () => {
    const bare = spotifyActivity(track({ track_id: null, image_id: undefined }), 1_000_000)!;
    expect(bare).not.toHaveProperty("sync_id");
    expect(bare).not.toHaveProperty("assets");
    const odd = spotifyActivity(track({ track_id: "short", image_id: "https://evil/x" }), 1_000_000)!;
    expect(odd).not.toHaveProperty("sync_id");
    expect(odd).not.toHaveProperty("assets");
    expect(activityListIsValid([bare, odd].slice(0, 1))).toBe(true);
  });

  it("truncates to the server's text rules and strips invisible characters", () => {
    const activity = spotifyActivity(track({ title: `${"é".repeat(200)}`, artists: ["x​y", "", "z"] }), 5_000)!;
    expect(Array.from(activity.details!)).toHaveLength(128);
    expect(activity.state).toBe("xy; z");
    expect(activityListIsValid([activity])).toBe(true);
  });

  it("is null without a title, and never starts before 0 or ends before it starts", () => {
    expect(spotifyActivity(null, 1)).toBeNull();
    expect(spotifyActivity(track({ title: " ​ " }), 1)).toBeNull();
    const early = spotifyActivity(track({ position_ms: 90_000 }), 1_000)!;
    expect(early.timestamps).toEqual({ start: 0, end: 200_000 });
    expect(spotifyActivity(track({ position_ms: 999_999 }), 1_000_000)!.timestamps).toEqual({ start: 800_000, end: 1_000_000 });
    expect(spotifyActivity(track({ duration_ms: 0 }), 1_000_000)!.timestamps).toEqual({ start: 940_000 });
  });

  it("does not resend an unchanged track but does for a new one or a seek", () => {
    const a = spotifyActivity(track(), 1_000_000);
    expect(sameSpotifyMoment(a, spotifyActivity(track({ position_ms: 65_000 }), 1_005_200))).toBe(true);
    expect(sameSpotifyMoment(a, spotifyActivity(track({ title: "Other" }), 1_000_000))).toBe(false);
    expect(sameSpotifyMoment(a, spotifyActivity(track({ position_ms: 120_000 }), 1_000_000))).toBe(false);
    expect(sameSpotifyMoment(a, null)).toBe(false);
    expect(sameSpotifyMoment(null, null)).toBe(true);
  });
});

describe("Spotify display helpers", () => {
  const activity = spotifyActivity(track(), 1_000_000)!;
  it("builds art and track URLs only from validated ids, with a search fallback", () => {
    expect(spotifyImageUrl(activity)).toBe(`https://i.scdn.co/image/${IMAGE}`);
    expect(spotifyImageUrl({ ...activity, assets: { large_image: "https://evil.example/x.png" } })).toBeNull();
    expect(spotifyOpenUrl(activity)).toBe("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
    expect(spotifyOpenUrl({ ...activity, sync_id: "../x" })).toBe("https://open.spotify.com/search/Song%20A%3B%20B");
  });

  it("shows the game before Spotify in lists", () => {
    const game = { name: "Factorio", type: 0 as const };
    expect(shownActivity({ activities: [activity, game] })).toBe(game);
    expect(shownActivity({ activities: [activity] })).toBe(activity);
    expect(listeningActivity({ activities: [game] })).toBeNull();
  });
});

describe("Windows track lookup", () => {
  const hit = (over: Partial<SpotifyTrack> = {}): SpotifyTrack => ({ uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC", title: "One More Time", artists: ["Daft Punk"], art: IMAGE, duration_ms: 320_000, explicit: false, ...over });
  const results = (tracks: SpotifyTrack[]): SpotifySearchResults => ({ tracks, albums: [], artists: [], playlists: [] });
  beforeEach(() => resetTrackLookups());

  it("takes the first result with the same name whose artists include the first artist", () => {
    const cover = hit({ uri: "spotify:track:0000000000000000000000", artists: ["Someone Else"] });
    expect(matchTrack("one more time", "DAFT PUNK", [cover, hit()])).toEqual({ sync_id: "4uLU6hMCjMI75M1A2tKUQC", image: IMAGE });
    expect(matchTrack("One More Time (Live)", "Daft Punk", [hit()])).toBeNull();
    expect(matchTrack("One More Time", "Daft Punk", [hit({ art: "not-hex" })])).toEqual({ sync_id: "4uLU6hMCjMI75M1A2tKUQC" });
    expect(matchTrack("One More Time", "Daft Punk", [hit({ uri: "spotify:episode:4uLU6hMCjMI75M1A2tKUQC" })])).toBeNull();
  });

  it("asks once per track, hits and misses alike, with Spotify's field filters", async () => {
    const find = vi.fn(async (q: string) => results(q.includes("One More Time") ? [hit()] : []));
    expect(await lookUpTrack("One More Time", "Daft Punk", find)).toMatchObject({ sync_id: "4uLU6hMCjMI75M1A2tKUQC" });
    expect(find).toHaveBeenCalledWith('track:"One More Time" artist:"Daft Punk"');
    await lookUpTrack("one more time", "daft punk", find);
    expect(await lookUpTrack("Unknown", "Nobody", find)).toBeNull();
    expect(await lookUpTrack("Unknown", "Nobody", find)).toBeNull();
    expect(find).toHaveBeenCalledTimes(2);
  });

  it("falls back quietly: a failure is a miss, and 404 10000 turns lookups off for the session", async () => {
    const limited = vi.fn(async () => Promise.reject(new ApiRequestError(429, { code: 0, message: "slow down" })));
    expect(await lookUpTrack("A", "B", limited)).toBeNull();
    const off = vi.fn(async () => Promise.reject(new ApiRequestError(404, { code: 10000, message: "Unknown" })));
    expect(await lookUpTrack("C", "D", off)).toBeNull();
    const find = vi.fn(async () => results([hit()]));
    expect(await lookUpTrack("One More Time", "Daft Punk", find)).toBeNull();
    expect(find).not.toHaveBeenCalled();
    expect(await lookUpTrack("x".repeat(100), "Daft Punk", find)).toBeNull();
  });

  it("adds the id and art only to an activity without them, in a shape the server accepts", () => {
    const windows = spotifyActivity(track({ track_id: null, image_id: null }), 1_000_000)!;
    const filled = withCatalog(windows, { sync_id: "4uLU6hMCjMI75M1A2tKUQC", image: IMAGE });
    expect(filled).toMatchObject({ sync_id: "4uLU6hMCjMI75M1A2tKUQC", assets: { large_image: `spotify:${IMAGE}` } });
    expect(activityListIsValid([filled])).toBe(true);
    expect(withCatalog(windows, null)).toBe(windows);
    const mac = spotifyActivity(track(), 1_000_000)!;
    expect(withCatalog(mac, { sync_id: "0000000000000000000000" })).toBe(mac);
  });
});
