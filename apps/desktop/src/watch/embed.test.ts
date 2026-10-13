import { describe, expect, it } from "vitest";
import { parseEmbedMessage } from "./embed";

const frame = {} as Window;
const ORIGIN = "https://vokko.example";
const msg = (data: unknown, over: Partial<{ origin: string; source: unknown }> = {}) => ({ origin: ORIGIN, source: frame, data, ...over }) as unknown as MessageEvent;

describe("parseEmbedMessage", () => {
  it("accepts the embed's events from its own origin and window", () => {
    expect(parseEmbedMessage(msg({ source: "vokko-embed", event: "ready" }), frame, ORIGIN)).toEqual({ event: "ready" });
    expect(parseEmbedMessage(msg({ source: "vokko-embed", event: "state", state: "playing" }), frame, ORIGIN)).toEqual({ event: "state", state: "playing" });
    expect(parseEmbedMessage(msg({ source: "vokko-embed", event: "time", seconds: 4, duration: 90 }), frame, ORIGIN)).toEqual({ event: "time", seconds: 4, duration: 90 });
    expect(parseEmbedMessage(msg({ source: "vokko-embed", event: "error", code: 153 }), frame, ORIGIN)).toEqual({ event: "error", code: 153 });
  });

  it("drops other origins, other windows, other shapes", () => {
    const ready = { source: "vokko-embed", event: "ready" };
    expect(parseEmbedMessage(msg(ready, { origin: "https://evil.example" }), frame, ORIGIN)).toBeNull();
    expect(parseEmbedMessage(msg(ready, { source: {} }), frame, ORIGIN)).toBeNull();
    expect(parseEmbedMessage(msg(ready), null, ORIGIN)).toBeNull();
    expect(parseEmbedMessage(msg({ event: "ready" }), frame, ORIGIN)).toBeNull();
    expect(parseEmbedMessage(msg("ready"), frame, ORIGIN)).toBeNull();
    expect(parseEmbedMessage(msg({ source: "vokko-embed", event: "state", state: "exploding" }), frame, ORIGIN)).toBeNull();
    expect(parseEmbedMessage(msg({ source: "vokko-embed", event: "time", seconds: "4", duration: 9 }), frame, ORIGIN)).toBeNull();
  });
});
