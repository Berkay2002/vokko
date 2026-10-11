import { describe, expect, it } from "vitest";
import { ApiRequestError, RateLimitedError } from "../api/errors";
import type { Invite } from "../api/types";
import { errorText, loadFailed, shownLoad } from "./inviteView";

const invite = { code: "abc" } as Invite;

describe("loadFailed", () => {
  it("maps 401 to the locked card and 404 to Invite Invalid", () => {
    expect(loadFailed(new ApiRequestError(401, { code: 0, message: "401: Unauthorized" }))).toEqual({ status: "locked" });
    expect(loadFailed(new ApiRequestError(404, { code: 10006, message: "Unknown Invite" }))).toEqual({ status: "invalid" });
  });

  it("keeps the invite out of the invalid state for rate limits and network errors", () => {
    expect(loadFailed(new RateLimitedError(2.2, false))).toEqual({ status: "failed", message: "You are being rate limited. Try again in 3s." });
    expect(loadFailed(new TypeError("fetch failed"))).toEqual({ status: "failed", message: "Could not reach the server." });
  });
});

describe("errorText", () => {
  it("shows the server's message, and a fallback for anything else", () => {
    expect(errorText(new ApiRequestError(403, { code: 40007, message: "The user is banned from this guild" }), "x")).toBe("The user is banned from this guild");
    expect(errorText(new Error("boom"), "Could not join this server. Try again.")).toBe("Could not join this server. Try again.");
  });
});

describe("shownLoad", () => {
  it("holds the card until READY when signed in", () => {
    expect(shownLoad({ status: "ok", invite }, true, false)).toEqual({ status: "loading" });
    expect(shownLoad({ status: "ok", invite }, true, true)).toEqual({ status: "ok", invite });
    expect(shownLoad({ status: "ok", invite }, false, false)).toEqual({ status: "ok", invite });
  });

  it("passes the other outcomes through", () => {
    expect(shownLoad({ status: "locked" }, false, false)).toEqual({ status: "locked" });
    expect(shownLoad({ status: "invalid" }, true, false)).toEqual({ status: "invalid" });
  });
});
