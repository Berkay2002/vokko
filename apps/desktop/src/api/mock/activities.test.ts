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

describe("mock app flag", () => {
  it("allows app on a game only, as a boolean", () => {
    expect(activityListIsValid([{ ...game, app: true }])).toBe(true);
    expect(activityListIsValid([{ ...game, app: "yes" as unknown as boolean }])).toBe(false);
    expect(activityListIsValid([{ ...spotify(), app: true }])).toBe(false);
  });
});

describe("mock app: images", () => {
  const hash = "ab".repeat(32);
  it("allows app:<64 hex> on a game only", () => {
    expect(activityListIsValid([{ ...game, assets: { large_image: `app:${hash}` } }])).toBe(true);
    for (const image of [`app:${hash.slice(1)}`, `app:${hash.toUpperCase()}`, `app:${hash}x`, "https://x.test/a.png"]) {
      expect(activityListIsValid([{ ...game, assets: { large_image: image } }]), image).toBe(false);
    }
    expect(activityListIsValid([{ ...spotify(), assets: { large_image: `app:${hash}` } }])).toBe(false);
  });
});
