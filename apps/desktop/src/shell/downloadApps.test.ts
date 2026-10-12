import { describe, expect, it } from "vitest";
import { canOfferDownloads, DOWNLOADS } from "./DownloadApps";

describe("download apps", () => {
  it("links the two installers by relative path", () => {
    expect(DOWNLOADS.map(d => [d.os, d.href])).toEqual([
      ["Windows", "/downloads/Vokko-windows-setup.exe"],
      ["macOS", "/downloads/Vokko-mac.dmg"],
    ]);
  });
  it("is offered in a browser and hidden inside the desktop app", () => {
    expect(canOfferDownloads(false)).toBe(true);
    expect(canOfferDownloads(true)).toBe(false);
  });
  it("defaults to the Tauri check (false under node)", () => expect(canOfferDownloads()).toBe(true));
});
