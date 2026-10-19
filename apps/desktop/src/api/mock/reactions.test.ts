import { describe, expect, it, vi } from "vitest";

vi.mock("./socket", () => ({ emit: () => {} }));

import { ApiRequestError } from "../errors";
import { parseEmoji } from "./routes";

// Mirrors the parse_emoji unit tests in crates/server/src/routes/reactions.rs.
const status = (raw: string): number => {
  try {
    parseEmoji(encodeURIComponent(raw));
  } catch (e) {
    if (e instanceof ApiRequestError) return e.status;
    throw e;
  }
  return 200;
};

describe("parseEmoji", () => {
  it("accepts keycap emoji, with or without U+FE0F", () => {
    for (const raw of ["1\u{FE0F}\u{20E3}", "0\u{FE0F}\u{20E3}", "9\u{FE0F}\u{20E3}", "#\u{FE0F}\u{20E3}", "*\u{FE0F}\u{20E3}", "1\u{20E3}", "#\u{20E3}"]) {
      expect(parseEmoji(encodeURIComponent(raw))).toEqual({ id: null, name: raw });
    }
  });

  it("rejects plain ASCII and broken keycaps", () => {
    const bad = [
      "", " ", "1", "a", "abc", "12\u{20E3}", "a\u{20E3}", "a\u{FE0F}\u{20E3}", "1\u{FE0F}", "1\u{20E3}\u{20E3}",
      "1\u{FE0F}\u{20E3}1", "1 \u{20E3}", "\u{1F600}a", "\u{1F600} \u{1F600}", "\u{1F600}\u{7}\u{1F600}",
    ];
    for (const raw of bad) expect(status(raw), JSON.stringify(raw)).toBe(400);
    expect(status("\u{1F600}".repeat(17)), "over 64 bytes").toBe(400);
  });

  it("still parses plain unicode and custom emoji", () => {
    expect(parseEmoji(encodeURIComponent("\u{1F600}"))).toEqual({ id: null, name: "\u{1F600}" });
    expect(parseEmoji(encodeURIComponent("\u{1F44D}\u{1F3FD}"))).toEqual({ id: null, name: "\u{1F44D}\u{1F3FD}" });
    expect(parseEmoji("party_1:123")).toEqual({ id: "123", name: "party_1" });
    expect(status("1\u{FE0F}\u{20E3}:123")).toBe(400);
  });
});
