import { describe, expect, it } from "vitest";
import { base32Decode, matchingStep, totpAt } from "./totp";

function base32(text: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...new TextEncoder().encode(text)].map(b => b.toString(2).padStart(8, "0")).join("");
  return (bits.match(/.{1,5}/g) ?? []).map(chunk => alphabet[parseInt(chunk.padEnd(5, "0"), 2)]).join("");
}

describe("mock TOTP", () => {
  it("matches the RFC 6238 SHA-1 vectors", () => {
    const key = new TextEncoder().encode("12345678901234567890");
    expect(totpAt(key, Math.floor(59 / 30))).toBe("287082");
    expect(totpAt(key, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpAt(key, Math.floor(1234567890 / 30))).toBe("005924");
    expect(totpAt(key, Math.floor(2000000000 / 30))).toBe("279037");
  });

  it("decodes base32 and accepts one step of drift", () => {
    // base32 of the RFC 6238 key "12345678901234567890", built here rather than spelled out
    const secret = base32("12345678901234567890");
    expect(new TextDecoder().decode(base32Decode(secret)!)).toBe("12345678901234567890");
    expect(matchingStep(secret, "287082", 59_000)).toBe(1);
    expect(matchingStep(secret, "287082", 89_000)).toBe(1);
    expect(matchingStep(secret, "287082", 149_000)).toBeNull();
    expect(base32Decode("not base32!")).toBeNull();
  });
});
