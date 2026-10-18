import { describe, expect, it } from "vitest";
import { emailProblem, registerProblems } from "./registerRules";

const filled = { email: "nova@example.com", username: "nova", password: "correct horse battery", dateOfBirth: "2000-01-31", consent: null };

describe("registerProblems", () => {
  it("flags every empty field at once", () => {
    expect(registerProblems({ email: "", username: " ", password: "", dateOfBirth: null, consent: false })).toEqual({
      email: "Required.",
      username: "Required.",
      password: "Required.",
      date_of_birth: "Required.",
      consent: "You need to agree to the terms.",
    });
  });

  it("checks the email shape and the server's username and password rules", () => {
    expect(registerProblems({ ...filled, email: "not-an-email", username: "No Spaces", password: "short" })).toEqual({
      email: "Not a well formed email address.",
      username: "Must be 2-32 characters: lowercase letters, numbers, '_' and '.'.",
      password: "Must be between 8 and 128 in length.",
    });
  });

  it("passes a good form, with or without terms", () => {
    expect(registerProblems(filled)).toEqual({});
    expect(registerProblems({ ...filled, consent: true })).toEqual({});
  });
});

describe("emailProblem", () => {
  it("matches the server's well-formed check", () => {
    for (const ok of ["a@b", "first.last@sub.example.se", " padded@example.com "]) expect(emailProblem(ok)).toBeNull();
    for (const bad of ["plain", "@example.com", "me@", "a@b@c", "me @example.com", `${"a".repeat(250)}@b.se`]) expect(emailProblem(bad)).not.toBeNull();
  });
});
