import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueSpeech = vi.hoisted(() => vi.fn(() => true));
const state = vi.hoisted(() => ({
  me: { id: "u1" } as { id: string } | null,
  route: { channelId: "c1" as string | null },
  relationships: {} as Record<string, { type: number }>,
  channels: {} as Record<string, unknown>,
  members: {},
  guilds: {},
  users: {},
}));
vi.mock("../ui/speech", () => ({ enqueueSpeech, speechAvailable: () => true }));
vi.mock("../ui/prefs", () => ({ getPrefs: () => ({ ttsPlayback: true, ttsRate: 1 }) }));
vi.mock("../api/store", () => ({ appStore: { getState: () => state }, displayName: (u: { username: string }) => u.username }));
vi.mock("../threads/threadUi", () => ({ useThreadUi: { getState: () => ({ openId: null }) } }));

import type { Message } from "../api/types";
import { TTS_STALE_MS, isStaleReplay, speakMessage } from "./tts";

const NOW = Date.parse("2026-10-12T12:00:00.000Z");
let seq = 0;
const msg = (over: Partial<Message> = {}, ageMs = 0): Message =>
  ({
    id: `m${++seq}`,
    channel_id: "c1",
    tts: true,
    content: "hello",
    timestamp: new Date(NOW - ageMs).toISOString(),
    author: { id: "u2", username: "Alice" },
    mentions: [],
    ...over,
  }) as unknown as Message;

describe("isStaleReplay", () => {
  it("is never stale for live messages, however old", () => expect(isStaleReplay(new Date(NOW - 60 * 60_000).toISOString(), false, NOW)).toBe(false));
  it("is stale for a replayed message older than the window", () => expect(isStaleReplay(new Date(NOW - TTS_STALE_MS - 1).toISOString(), true, NOW)).toBe(true));
  it("keeps a replayed message at the edge of the window", () => expect(isStaleReplay(new Date(NOW - TTS_STALE_MS).toISOString(), true, NOW)).toBe(false));
  it("does not treat an unparsable timestamp as stale", () => expect(isStaleReplay("not a date", true, NOW)).toBe(false));
});

describe("speakMessage replay window", () => {
  beforeEach(() => {
    enqueueSpeech.mockClear();
    state.me = { id: "u1" };
    state.route.channelId = "c1";
  });

  it("speaks a fresh live tts message", () => {
    speakMessage(msg(), false, NOW);
    expect(enqueueSpeech).toHaveBeenCalledWith("Alice said hello", 1);
  });
  it("speaks a recent message replayed right after a reconnect", () => {
    speakMessage(msg({}, 10_000), true, NOW);
    expect(enqueueSpeech).toHaveBeenCalledTimes(1);
  });
  it("does not speak a reconnect replay older than the window", () => {
    speakMessage(msg({}, TTS_STALE_MS + 1_000), true, NOW);
    expect(enqueueSpeech).not.toHaveBeenCalled();
  });
  it("still speaks an old timestamp outside a replay (live event, skewed clock)", () => {
    speakMessage(msg({}, TTS_STALE_MS + 1_000), false, NOW);
    expect(enqueueSpeech).toHaveBeenCalledTimes(1);
  });
  it("does not speak my own tts messages", () => {
    speakMessage(msg({ author: { id: "u1", username: "Me" } as unknown as Message["author"] }), false, NOW);
    expect(enqueueSpeech).not.toHaveBeenCalled();
  });
  it("does not speak a tts message in a channel I am not viewing", () => {
    speakMessage(msg({ channel_id: "c9" }), false, NOW);
    expect(enqueueSpeech).not.toHaveBeenCalled();
  });
  it("speaks a replayed id only once", () => {
    const m = msg();
    speakMessage(m, false, NOW);
    speakMessage(m, true, NOW);
    expect(enqueueSpeech).toHaveBeenCalledTimes(1);
  });
});
