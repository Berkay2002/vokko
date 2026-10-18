import { describe, expect, it } from "vitest";
import { inviteOrigin } from "../invites/api";
import { messageLink } from "./nav";

describe("messageLink", () => {
  it("builds guild and DM links on the given origin", () => {
    expect(messageLink("1", "2", "3", "https://vokko.example")).toBe("https://vokko.example/channels/1/2/3");
    expect(messageLink(null, "2", "3", "https://vokko.example")).toBe("https://vokko.example/channels/@me/2/3");
  });

  it("in the desktop app points at the API origin, not the webview's tauri:// origin", () => {
    expect(messageLink("1", "2", "3", inviteOrigin(true, "https://vokko.example.com/api/v1", "tauri://localhost"))).toBe("https://vokko.example.com/channels/1/2/3");
  });
});
