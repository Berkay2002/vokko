import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_QUEUED_SPEECH, enqueueSpeech, resetSpeechQueue } from "../ui/speech";
import { shouldSpeak, spokenText, type TtsDecisionInput } from "./tts";

type Author = TtsDecisionInput["message"]["author"];
const base = (over: Partial<TtsDecisionInput> = {}, message: Partial<TtsDecisionInput["message"]> = {}): TtsDecisionInput => ({
  message: { id: "m1", channel_id: "c1", tts: true, author: { id: "u2" } as Author, ...message },
  meId: "u1",
  viewedChannelIds: ["c1"],
  focused: true,
  playback: true,
  available: true,
  spoken: new Set(),
  ...over,
});

describe("shouldSpeak", () => {
  it("speaks a tts message in the viewed channel from someone else", () => expect(shouldSpeak(base())).toBe(true));
  it("ignores messages without tts", () => expect(shouldSpeak(base({}, { tts: false }))).toBe(false));
  it("ignores my own messages", () => expect(shouldSpeak(base({}, { author: { id: "u1" } as Author }))).toBe(false));
  it("needs the channel to be the viewed one", () => {
    expect(shouldSpeak(base({ viewedChannelIds: ["c9"] }))).toBe(false);
    expect(shouldSpeak(base({ viewedChannelIds: [] }))).toBe(false);
  });
  it("counts the thread open in the side panel as viewed", () => expect(shouldSpeak(base({ viewedChannelIds: ["parent", "c1"] }))).toBe(true));
  it("ignores blocked authors", () => expect(shouldSpeak(base({ blocked: true }))).toBe(false));
  it("needs a visible, focused window", () => expect(shouldSpeak(base({ focused: false }))).toBe(false));
  it("respects the playback preference", () => expect(shouldSpeak(base({ playback: false }))).toBe(false));
  it("needs speech synthesis", () => expect(shouldSpeak(base({ available: false }))).toBe(false));
  it("skips replays of old messages", () => expect(shouldSpeak(base({ stale: true }))).toBe(false));
  it("never speaks the same id twice", () => expect(shouldSpeak(base({ spoken: new Set(["m1"]) }))).toBe(false));
  it("needs to know who I am", () => expect(shouldSpeak(base({ meId: null }))).toBe(false));
});

describe("spokenText", () => {
  const ctx = { authorName: "Alice", userName: (id: string) => (id === "5" ? "Bob" : null), roleName: () => null, channelNameOf: () => null };
  it("says who said what", () => expect(spokenText({ content: "hi <@5>" }, ctx)).toBe("Alice said hi @Bob"));
  it("reads spoilers, links and unknown mentions generically", () => {
    expect(spokenText({ content: "||secret|| see https://example.com/x <@9> <@&8> <#7>" }, ctx)).toBe("Alice said spoiler see a link someone a role a channel");
  });
  it("drops markdown markers", () => {
    expect(spokenText({ content: "**bold** _soft_ ~~gone~~ `code` snake_case" }, ctx)).toBe("Alice said bold soft gone code snake_case");
  });
  it("is empty without content", () => expect(spokenText({ content: "  " }, ctx)).toBe(""));
});

describe("enqueueSpeech", () => {
  const spoken: { text: string; onend?: () => void }[] = [];
  const cancel = vi.fn();
  beforeEach(() => {
    spoken.length = 0;
    cancel.mockClear();
    resetSpeechQueue();
    vi.stubGlobal("window", { speechSynthesis: { speak: (u: { text: string; onend?: () => void }) => spoken.push(u), cancel } });
    vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(public text: string) {} rate = 1; onend?: () => void; onerror?: () => void; });
  });

  it("queues without cancelling what is playing", () => {
    expect(enqueueSpeech("one", 1)).toBe(true);
    expect(enqueueSpeech("two", 1)).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(spoken.map(u => u.text)).toEqual(["one", "two"]);
  });
  it("drops messages beyond the limit until one finishes", () => {
    for (let i = 0; i < MAX_QUEUED_SPEECH; i++) expect(enqueueSpeech(`m${i}`, 1)).toBe(true);
    expect(enqueueSpeech("late", 1)).toBe(false);
    spoken[0]?.onend?.();
    expect(enqueueSpeech("after", 1)).toBe(true);
  });
});
