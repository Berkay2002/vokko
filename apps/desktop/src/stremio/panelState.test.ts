import { describe, expect, it } from "vitest";
import type { StremioContinueItem, StremioSearchItem, StremioVideo } from "../api/types";
import { bestStream, currentView, episodeLabel, initialPanel, nextVideo, panelReducer, progressOf, resumeTarget, seasonsOf, type PanelAction, type PanelState } from "./panelState";

const run = (actions: PanelAction[], from: PanelState = initialPanel) => actions.reduce(panelReducer, from);
const show: StremioSearchItem = { id: "tt0903747", type: "series", name: "Breaking Bad" };
const link = { code: "K7QX", link: "https://link.stremio.com/K7QX", expires_at: "2026-10-17T12:00:00Z" };

describe("Stremio panel account flow", () => {
  it("starts loading and learns whether the account is linked", () => {
    expect(initialPanel.account).toBe("loading");
    expect(run([{ type: "account", linked: true }]).account).toBe("linked");
    expect(run([{ type: "account", linked: false }]).account).toBe("unlinked");
    expect(run([{ type: "unavailable" }]).account).toBe("unavailable");
  });

  it("links with a code, falls back to email and back, and links", () => {
    let s = run([{ type: "account", linked: false }, { type: "linkStarted", link }]);
    expect(s).toMatchObject({ account: "linking", link });
    s = run([{ type: "showEmail" }], s);
    expect(s.account).toBe("email");
    expect(run([{ type: "showLink" }], s).account).toBe("linking");
    expect(run([{ type: "linked" }], s)).toMatchObject({ account: "linked", link: null, problem: null });
  });

  it("returns a failed code step to the card and keeps the email form open", () => {
    const linking = run([{ type: "account", linked: false }, { type: "linkStarted", link }]);
    expect(run([{ type: "linkFailed", message: "expired" }], linking)).toMatchObject({ account: "unlinked", link: null, problem: "expired" });
    const email = run([{ type: "showEmail" }], linking);
    expect(run([{ type: "linkFailed", message: "bad password" }], email)).toMatchObject({ account: "email", problem: "bad password" });
    expect(run([{ type: "showLink" }], run([{ type: "account", linked: false }])).account).toBe("unlinked");
  });

  it("unlinking forgets everything the panel showed", () => {
    const s = run([{ type: "account", linked: true }, { type: "query", query: "heat" }, { type: "openTitle", item: show }, { type: "unlinked" }]);
    expect(s).toEqual({ ...initialPanel, account: "unlinked" });
  });
});

describe("Stremio panel navigation", () => {
  it("opens a title, then an episode's streams, and Back pops one step at a time", () => {
    let s = run([{ type: "account", linked: true }, { type: "openTitle", item: show }]);
    expect(currentView(s)).toEqual({ name: "title", item: show });
    s = run([{ type: "openStreams", videoId: "tt0903747:1:2", label: "S1E2" }], s);
    expect(currentView(s)).toMatchObject({ name: "streams", videoId: "tt0903747:1:2", item: show });
    s = run([{ type: "back" }], s);
    expect(currentView(s).name).toBe("title");
    s = run([{ type: "back" }], s);
    expect(currentView(s).name).toBe("home");
    expect(run([{ type: "back" }], s)).toBe(s);
  });

  it("has nothing to open streams for from the home view, and a new query goes back home", () => {
    expect(run([{ type: "openStreams", videoId: "tt1", label: "x" }])).toBe(initialPanel);
    const s = run([{ type: "openTitle", item: show }, { type: "query", query: "heat" }]);
    expect(s).toMatchObject({ query: "heat", trail: [{ name: "home" }] });
  });
});

describe("Stremio panel helpers", () => {
  it("pre-selects the first playable stream", () => {
    expect(bestStream([{ playable: false, n: 1 }, { playable: true, n: 2 }, { playable: true, n: 3 }])?.n).toBe(2);
    expect(bestStream([{ playable: false }])).toBeUndefined();
  });

  it("lists seasons ascending with specials last", () => {
    expect(seasonsOf([{ season: 2 }, { season: 0 }, { season: 1 }, { season: 2 }])).toEqual([1, 2, 0]);
  });
});

describe("Continue watching", () => {
  const NOW = Date.parse("2026-10-17T12:00:00Z");
  const videos: StremioVideo[] = [
    { id: "tt1:1:1", season: 1, episode: 1 },
    { id: "tt1:1:2", season: 1, episode: 2 },
    { id: "tt1:2:1", season: 2, episode: 1 },
    { id: "tt1:0:1", season: 0, episode: 1 },
  ];
  const episode = (video_id: string, position_ms: number, duration_ms = 3_000_000): StremioContinueItem => {
    const [, season, ep] = video_id.split(":");
    return { id: "tt1", type: "series", name: "Show", video_id, season: Number(season), episode: Number(ep), position_ms, duration_ms };
  };
  const film: StremioContinueItem = { id: "tt2", type: "movie", name: "Film", position_ms: 3_600_000, duration_ms: 7_200_000 };

  it("opens the title with the card it came from", () => {
    const item = episode("tt1:1:2", 100);
    expect(currentView(run([{ type: "openTitle", item: show, resume: item }]))).toMatchObject({ name: "title", resume: item });
    expect(currentView(run([{ type: "openTitle", item: show }]))).not.toHaveProperty("resume");
  });

  it("resumes an unfinished episode or film where it was left", () => {
    expect(resumeTarget(episode("tt1:1:2", 1_500_000), videos, NOW)).toEqual({ videoId: "tt1:1:2", positionMs: 1_500_000, next: false });
    expect(resumeTarget(film, [], NOW)).toEqual({ videoId: null, positionMs: 3_600_000, next: false });
  });

  it("offers the next episode from 0 once the credits have started", () => {
    expect(resumeTarget(episode("tt1:1:1", 2_800_000), videos, NOW)).toEqual({ videoId: "tt1:1:2", positionMs: 0, next: true });
    expect(resumeTarget(episode("tt1:1:2", 2_800_000), videos, NOW)).toEqual({ videoId: "tt1:2:1", positionMs: 0, next: true });
    // Exactly 90% is not past the line yet.
    expect(resumeTarget(episode("tt1:1:1", 2_700_000), videos, NOW).next).toBe(false);
  });

  it("treats the server's waiting next episode (duration 0) as one to play from the start", () => {
    expect(resumeTarget(episode("tt1:2:1", 0, 0), videos, NOW)).toEqual({ videoId: "tt1:2:1", positionMs: 0, next: true });
    expect(episodeLabel(episode("tt1:2:1", 0, 0))).toBe("S2E1 · Up next");
  });

  it("stays on the episode when there is nothing after it", () => {
    expect(resumeTarget(episode("tt1:2:1", 2_900_000), videos, NOW)).toEqual({ videoId: "tt1:2:1", positionMs: 0, next: false });
    expect(resumeTarget({ ...film, position_ms: 7_000_000 }, [], NOW)).toEqual({ videoId: null, positionMs: 0, next: false });
  });

  it("skips an unreleased next episode and never walks from a season into the specials", () => {
    const upcoming = [...videos, { id: "tt1:2:2", season: 2, episode: 2, released: "2027-01-01T00:00:00Z" }];
    expect(nextVideo(upcoming, "tt1:2:1", NOW)).toBeUndefined();
    expect(nextVideo(videos, "tt1:2:1", NOW)).toBeUndefined();
    expect(nextVideo(videos, "tt1:0:1", NOW)).toBeUndefined();
    expect(nextVideo(videos, "tt9:1:1", NOW)).toBeUndefined();
  });

  it("labels episodes and measures progress", () => {
    expect(episodeLabel(episode("tt1:2:5", 10))).toBe("S2E5");
    expect(episodeLabel(film)).toBeNull();
    expect(progressOf(film)).toBe(0.5);
    expect(progressOf({ position_ms: 5, duration_ms: 0 })).toBe(0);
    expect(progressOf({ position_ms: 9_000_000, duration_ms: 7_200_000 })).toBe(1);
  });
});
