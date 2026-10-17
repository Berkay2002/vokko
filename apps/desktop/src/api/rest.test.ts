import { describe, expect, it } from "vitest";
import { OFFLINE_MESSAGE, toApiError } from "./rest";

describe("toApiError", () => {
  it("keeps the server's JSON error", () => {
    expect(toApiError(403, JSON.stringify({ code: 50013, message: "Missing Permissions" }))).toEqual({ code: 50013, message: "Missing Permissions" });
  });

  it("turns a proxy's HTML error page into a short message", () => {
    const page = "<!DOCTYPE html><html><head><title>Bad gateway | example.com | Cloudflare</title></head><body>…</body></html>";
    expect(toApiError(502, page).message).toBe("Vokko is restarting, try again in a moment.");
    expect(toApiError(524, page).message).toBe("Vokko is restarting, try again in a moment.");
    expect(toApiError(500, page).message).toBe("Vokko had a problem (HTTP 500). Try again.");
    expect(toApiError(500, "").message).toBe("Vokko had a problem (HTTP 500). Try again.");
  });

  it("keeps a short plain-text body", () => {
    expect(toApiError(400, "Invalid JSON body").message).toBe("Invalid JSON body");
  });

  it("has a short offline message", () => {
    expect(OFFLINE_MESSAGE).toBe("Can't reach Vokko. Check your connection.");
  });
});
