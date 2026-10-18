import { describe, expect, it } from "vitest";
import { inviteOrigin } from "../invites/api";
import { messageLink, messagePathOf } from "./nav";

describe("messageLink", () => {
  it("builds guild and DM links on the given origin", () => {
    expect(messageLink("1", "2", "3", "https://vokko.example")).toBe("https://vokko.example/channels/1/2/3");
    expect(messageLink(null, "2", "3", "https://vokko.example")).toBe("https://vokko.example/channels/@me/2/3");
  });

  it("recognises its own message links only", () => {
    const origins = ["https://vokko.example.com"];
    expect(messagePathOf("https://vokko.example.com/channels/1/2/3", origins)).toBe("/channels/1/2/3");
    expect(messagePathOf("https://vokko.example.com/channels/@me/2/3", origins)).toBe("/channels/@me/2/3");
    expect(messagePathOf("https://evil.example/channels/1/2/3", origins)).toBeNull();
    expect(messagePathOf("https://vokko.example.com/channels/1/2", origins)).toBeNull();
    expect(messagePathOf("not a url", origins)).toBeNull();
  });

  it("in the desktop app points at the API origin, not the webview's tauri:// origin", () => {
    expect(messageLink("1", "2", "3", inviteOrigin(true, "https://vokko.example.com/api/v1", "tauri://localhost"))).toBe("https://vokko.example.com/channels/1/2/3");
  });
});
