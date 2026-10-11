import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterSignInPath, pendingInvite } from "./pendingInvite";

// The suite runs in node: give pendingInvite a sessionStorage of its own.
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("afterSignInPath", () => {
  it("falls back to home without a pending invite", () => {
    expect(afterSignInPath()).toBe("/channels/@me");
  });

  it("returns to the pending invite, encoding the code", () => {
    pendingInvite.set("abc123");
    expect(afterSignInPath()).toBe("/invite/abc123");
    pendingInvite.set("a/b c?");
    expect(afterSignInPath()).toBe("/invite/a%2Fb%20c%3F");
  });

  it("is home again once the code is cleared", () => {
    pendingInvite.set("abc123");
    pendingInvite.clear();
    expect(afterSignInPath()).toBe("/channels/@me");
  });
});
