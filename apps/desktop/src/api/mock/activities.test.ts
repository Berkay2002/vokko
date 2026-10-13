import { describe, expect, it } from "vitest";
import type { Activity } from "../types";
import { activityListIsValid } from "./activities";

const spotify = (): Activity => ({
  name: "Spotify",
  type: 2,
  details: "Song",
  state: "A; B",
  sync_id: "4uLU6hMCjMI75M1A2tKUQC",
  assets: { large_image: `spotify:${"ab01".repeat(10)}` },
  timestamps: { start: 1000, end: 2000 },
});
const game: Activity = { name: "Factorio", type: 0, timestamps: { start: 5 } };

describe("mock activity validation (same rules as the server)", () => {
  it("accepts a game, Spotify, and both; Spotify without track id or art", () => {
    expect(activityListIsValid([])).toBe(true);
    expect(activityListIsValid([game, spotify()])).toBe(true);
    expect(activityListIsValid([{ name: "Spotify", type: 2, details: "x" }])).toBe(true);
  });

  it("rejects the lists the server closes 4002 for", () => {
    const bad: Activity[][] = [
      [spotify(), spotify()],
      [game, game],
      [{ ...spotify(), name: "Apple Music" }],
      [{ ...spotify(), details: " " }],
      [{ ...spotify(), state: "a​b" }],
      [{ ...spotify(), assets: { large_image: "https://i.scdn.co/image/ab" } }],
      [{ ...spotify(), sync_id: "short" }],
      [{ ...spotify(), timestamps: { start: 2000, end: 1000 } }],
      [{ ...spotify(), timestamps: { end: -1 } }],
      [{ ...game, details: "x" }],
      [{ ...game, name: "A\nB" }],
      [{ name: "A", type: 1 } as unknown as Activity],
    ];
    for (const list of bad) expect(activityListIsValid(list), JSON.stringify(list)).toBe(false);
  });
});
