import { describe, expect, it } from "vitest";
import { WEAK_PASSWORD, passwordProblem, passwordStrength } from "./password";

describe("password rules", () => {
  it("mirrors the server's rejections", () => {
    expect(passwordProblem("short")).toBe("Must be between 8 and 128 in length.");
    expect(passwordProblem("Password123")).toBe(WEAK_PASSWORD);
    expect(passwordProblem("aaaaaaaaaaaa")).toBe(WEAK_PASSWORD);
    expect(passwordProblem("my-sam-secret", ["sam"])).toBe(WEAK_PASSWORD);
    expect(passwordProblem("alice-in-chains", ["bob", "alice@x.io"])).toBe(WEAK_PASSWORD);
    expect(passwordProblem("correct horse battery", ["sam", "sam@example.test"])).toBeNull();
  });

  it("scores length and variety", () => {
    expect(passwordStrength("password")).toBe(0);
    expect(passwordStrength("plainword")).toBe(1);
    expect(passwordStrength("plainwordlonger")).toBe(2);
    expect(passwordStrength("Plain-word-longer-9")).toBe(4);
  });
});
