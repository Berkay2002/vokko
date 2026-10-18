import { describe, expect, it } from "vitest";
import { buildReport, clean, stripIds } from "./crashReporter";

describe("crash reports", () => {
  it("removes ids from the route", () => {
    expect(stripIds("/channels/123456789012345678/876543210987654321")).toBe("/channels/:id/:id");
    expect(stripIds("/channels/@me")).toBe("/channels/@me");
  });

  it("scrubs secrets, never sends message content, and sends each error once", () => {
    const error = new TypeError("bad token=abcdef123456");
    const report = buildReport("error", error, "0.1.9");
    expect(report?.message).toBe("TypeError: bad token=[redacted]");
    expect(report?.kind).toBe("error");
    expect(buildReport("error", error, "0.1.9")).toBeNull();
    const rejection = buildReport("unhandled_rejection", { code: 50001, content: "secret chat text" }, "0.1.9");
    expect(rejection?.message).toBe('{"code":50001}');
    expect(buildReport("unhandled_rejection", { user: { email: "a@b.c" } }, "0.1.9")?.message).toBe("non-Error rejection (object)");
  });

  it("removes the account name from home-directory paths", () => {
    expect(clean("at C:\\Users\\alice\\.cargo\\x.rs:1 and /home/bob/src and /Users/carol/Library")).toBe("at C:\\Users\\~\\.cargo\\x.rs:1 and /home/~/src and /Users/~/Library");
  });

  it("drops browser noise and stops after ten reports", () => {
    expect(buildReport("error", "ResizeObserver loop completed with undelivered notifications.", "1")).toBeNull();
    expect(buildReport("error", "Script error.", "1")).toBeNull();
    const sent = Array.from({ length: 12 }, (_, i) => buildReport("error", `boom ${i}`, "1")).filter(Boolean);
    expect(sent.length).toBeLessThanOrEqual(10);
  });
});
