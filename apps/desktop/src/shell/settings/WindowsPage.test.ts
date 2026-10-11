import { describe, expect, it } from "vitest";
import { updateSummary } from "./WindowsPage";

describe("updateSummary", () => {
  it("says what the updater is doing", () => {
    expect(updateSummary({ state: "disabled" }, null)).toMatch(/not set up for this build/);
    expect(updateSummary({ state: "checking" }, "0.1.0")).toBe("Checking for updates…");
    expect(updateSummary({ state: "available", version: "0.2.0", notes: null }, "0.1.0")).toBe("Vokko 0.2.0 is available.");
    expect(updateSummary({ state: "downloading", version: "0.2.0", downloaded: 512, total: 2048 }, "0.1.0")).toBe("Downloading Vokko 0.2.0 (25%)…");
    expect(updateSummary({ state: "downloading", version: "0.2.0", downloaded: 512, total: null }, "0.1.0")).toBe("Downloading Vokko 0.2.0…");
    expect(updateSummary({ state: "ready", version: "0.2.0" }, "0.1.0")).toBe("Vokko 0.2.0 is ready to install.");
    expect(updateSummary({ state: "error", message: "offline" }, "0.1.0")).toBe("Could not check for updates: offline");
    expect(updateSummary({ state: "upToDate" }, "0.1.0")).toBe("Vokko is up to date (0.1.0).");
  });
});
