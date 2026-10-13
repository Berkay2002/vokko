import { describe, expect, it } from "vitest";
import { DRIFT_MS, expectedPositionMs, formatClock, needsSeek, parseYouTubeLink } from "./youtube";

const ID = "dQw4w9WgXcQ";

describe("parseYouTubeLink", () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`],
    [`https://youtube.com/watch?v=${ID}&t=42s`],
    [`https://www.youtube.com/watch?list=PL123&v=${ID}`],
    [`https://m.youtube.com/watch?v=${ID}`],
    [`https://music.youtube.com/watch?v=${ID}&si=abc`],
    [`https://youtu.be/${ID}`],
    [`https://youtu.be/${ID}?t=9`],
    [`https://www.youtube.com/shorts/${ID}`],
    [`https://www.youtube.com/live/${ID}?feature=share`],
    [`https://www.youtube.com/embed/${ID}`],
    [`https://www.youtube-nocookie.com/embed/${ID}`],
    [`youtube.com/watch?v=${ID}`],
    [`  http://youtu.be/${ID}  `],
    [ID],
  ])("finds the id in %s", link => {
    expect(parseYouTubeLink(link)).toBe(ID);
  });

  it.each([
    [""],
    ["hello"],
    ["https://www.youtube.com/"],
    ["https://www.youtube.com/watch"],
    ["https://www.youtube.com/watch?v=short"],
    ["https://www.youtube.com/playlist?list=PL1234567890A"],
    ["https://www.youtube.com/@someone"],
    [`https://vimeo.com/watch?v=${ID}`],
    [`https://evil.example/youtube.com/watch?v=${ID}`],
    [`https://youtube.com.evil.example/watch?v=${ID}`],
    [`javascript:alert(1)//youtu.be/${ID}`],
    [`ftp://youtu.be/${ID}`],
    [`https://youtu.be/${ID}x`],
  ])("refuses %s", link => {
    expect(parseYouTubeLink(link)).toBeNull();
  });
});

describe("sync maths", () => {
  const state = { playing: true, position_ms: 10_000, updated_at_ms: 1_000_000 };
  it("a playing video moves on with the clock, a paused one stays", () => {
    expect(expectedPositionMs(state, 1_004_500)).toBe(14_500);
    expect(expectedPositionMs({ ...state, playing: false }, 1_004_500)).toBe(10_000);
    expect(expectedPositionMs(state, 999_000)).toBe(10_000);
  });
  it("seeks only when the drift is over two seconds", () => {
    expect(DRIFT_MS).toBe(2000);
    expect(needsSeek(12_000, 14_000)).toBe(false);
    expect(needsSeek(11_999, 14_000)).toBe(true);
    expect(needsSeek(16_100, 14_000)).toBe(true);
  });
  it("formats clocks", () => {
    expect([formatClock(0), formatClock(187_000), formatClock(3_729_000)]).toEqual(["0:00", "3:07", "1:02:09"]);
  });
});
