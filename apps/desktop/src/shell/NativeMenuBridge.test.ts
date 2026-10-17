import { describe, expect, it } from "vitest";
import { menuModal } from "./NativeMenuBridge";

describe("menuModal", () => {
  it("maps each macOS menu action onto a modal that already exists", () => {
    expect(menuModal("settings")).toEqual({ type: "userSettings" });
    expect(menuModal("quick-switcher")).toEqual({ type: "quickSwitcher" });
    expect(menuModal("inbox")).toEqual({ type: "inbox" });
    expect(menuModal("shortcuts")).toEqual({ type: "shortcuts" });
    expect(menuModal("report-problem")).toEqual({ type: "reportProblem" });
    // same page the title bar's Help button opens
    expect(menuModal("help")).toEqual({ type: "userSettings", section: "keybinds" });
  });
});
