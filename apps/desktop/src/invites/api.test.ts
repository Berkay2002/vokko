import { describe, expect, it } from "vitest";
import { inviteLink, inviteOrigin } from "./api";

describe("inviteOrigin", () => {
  it("uses the page origin in a browser, with or without an API configured", () => {
    expect(inviteOrigin(false, "", "https://vokko.example.com")).toBe("https://vokko.example.com");
    expect(inviteOrigin(false, "https://vokko.example.com", "https://vokko.example.com")).toBe("https://vokko.example.com");
  });
  it("uses the API origin in the desktop app", () => {
    expect(inviteOrigin(true, "https://vokko.example.com", "http://tauri.localhost")).toBe("https://vokko.example.com");
    expect(inviteOrigin(true, "https://vokko.example.com/api", "tauri://localhost")).toBe("https://vokko.example.com");
  });
  it("falls back to the page origin in desktop mock mode or on a bad API value", () => {
    expect(inviteOrigin(true, "", "http://localhost:1420")).toBe("http://localhost:1420");
    expect(inviteOrigin(true, "not a url", "http://localhost:1420")).toBe("http://localhost:1420");
  });
});

describe("inviteLink", () => {
  it("builds <origin>/invite/<code>", () => {
    expect(inviteLink("abc123", "https://vokko.example.com")).toBe("https://vokko.example.com/invite/abc123");
  });
});
