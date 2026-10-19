import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../errors";
import { confirmPassword } from "./accounts";
import { createAccount } from "./ops";

const statusOf = (fn: () => void): number | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof ApiRequestError) return e.status;
    throw e;
  }
};

describe("mock current-password check", () => {
  it("answers 429 after 10 wrong passwords, even for the right one; a missing or right one does not count", () => {
    const account = createAccount({ username: "lockout", password: "right" });
    for (let i = 0; i < 5; i++) expect(statusOf(() => confirmPassword(account, undefined))).toBe(400);
    expect(statusOf(() => confirmPassword(account, "right"))).toBeNull();
    for (let i = 0; i < 10; i++) expect(statusOf(() => confirmPassword(account, "wrong"))).toBe(400);
    expect(statusOf(() => confirmPassword(account, "right"))).toBe(429);
    expect(statusOf(() => confirmPassword(account, "wrong"))).toBe(429);
  });
});
