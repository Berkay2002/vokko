import { describe, expect, it } from "vitest";
import { activeCue, addCue, languageName, onCues, parseCue, preferredTrack, receiveCue, subtitleTopic, trackName } from "./subtitles";

const bytes = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

describe("cues from the media room", () => {
  it("accepts a plain cue and refuses anything malformed", () => {
    expect(parseCue(bytes({ start_ms: 1000, end_ms: 2500, text: "Hello" }))).toEqual({ start_ms: 1000, end_ms: 2500, text: "Hello" });
    for (const bad of ["not json", "null", "[]", { start_ms: 1, end_ms: 2 }, { start_ms: "1", end_ms: 2, text: "x" }, { start_ms: -1, end_ms: 2, text: "x" }, { start_ms: 5, end_ms: 5, text: "x" }, { start_ms: 1, end_ms: Infinity, text: "x" }, { start_ms: 1e12, end_ms: 1e12 + 1, text: "x" }, { start_ms: 1, end_ms: 2, text: "  " }]) {
      expect(parseCue(bytes(bad)), JSON.stringify(bad)).toBeNull();
    }
  });

  it("caps the text and the time, and drops control and direction characters", () => {
    const cue = parseCue(bytes({ start_ms: 0, end_ms: 600_000, text: `a\u0000b‮c${"x".repeat(1000)}` }));
    expect(cue?.end_ms).toBe(30_000);
    expect(cue?.text.length).toBe(300);
    expect(cue?.text.startsWith("abcx")).toBe(true);
    expect(parseCue(bytes({ start_ms: 0, end_ms: 1000, text: "two\nlines" }))?.text).toBe("two\nlines");
  });

  it("hands only subs: topics from the right bot to the listener", () => {
    const got: string[] = [];
    const off = onCues("bot:a", (topic, cue) => got.push(`${topic}:${cue.text}`));
    const cue = bytes({ start_ms: 0, end_ms: 1000, text: "hi" });
    receiveCue("bot:a", subtitleTopic(4), cue);
    receiveCue("bot:b", subtitleTopic(4), cue);
    receiveCue("bot:a", "chat", cue);
    receiveCue("bot:a", undefined, cue);
    receiveCue("bot:a", subtitleTopic(5), bytes("junk"));
    off();
    receiveCue("bot:a", subtitleTopic(4), cue);
    expect(got).toEqual(["subs:4:hi"]);
  });

  it("shows the cue that is on at the position, the latest start when they overlap", () => {
    const cues = [
      { start_ms: 0, end_ms: 4000, text: "a" },
      { start_ms: 3000, end_ms: 6000, text: "b" },
    ];
    expect(activeCue(cues, 1000)?.text).toBe("a");
    expect(activeCue(cues, 3500)?.text).toBe("b");
    expect(activeCue(cues, 6000)).toBeUndefined();
    expect(activeCue([], 0)).toBeUndefined();
  });

  it("keeps a bounded list without duplicates", () => {
    const one = { start_ms: 0, end_ms: 1000, text: "a" };
    const list = addCue([], one);
    expect(addCue(list, { ...one })).toBe(list);
    let long = list;
    for (let i = 1; i <= 5; i++) long = addCue(long, { start_ms: i * 1000, end_ms: i * 1000 + 500, text: "x" }, 3);
    expect(long.map(c => c.start_ms)).toEqual([3000, 4000, 5000]);
  });
});

describe("language names", () => {
  it("names ISO codes, including the bibliographic ones files use", () => {
    expect(languageName("eng")).toBe("English");
    expect(languageName("swe")).toBe("Swedish");
    expect(languageName("fre")).toBe("French");
    expect(languageName("ger")).toBe("German");
    expect(languageName("sv-se")).toMatch(/^Swedish/);
    expect(languageName(undefined)).toBe("Unknown");
    expect(languageName("zzzz9")).toBe("ZZZZ9");
    expect(trackName({ language: "eng", title: "Commentary" })).toBe("English · Commentary");
    expect(trackName({})).toBe("Unknown");
  });

  it("picks the text track in the remembered language", () => {
    const state = { subtitle_tracks: [{ id: 3, kind: "bitmap" as const, language: "eng", codec: "x", forced: false, default: false }, { id: 4, kind: "text" as const, language: "eng", codec: "x", forced: false, default: false }] };
    expect(preferredTrack(state, "eng")).toBe(4);
    expect(preferredTrack(state, "swe")).toBeUndefined();
    expect(preferredTrack(state, null)).toBeUndefined();
    expect(preferredTrack({}, "eng")).toBeUndefined();
  });
});
