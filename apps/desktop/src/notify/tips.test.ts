import { describe, expect, it } from "vitest";
import { TIPS, tipAt } from "./tips";

describe("startup tips", () => {
  it("label shortcut keys the way the OS does", () => {
    const quick = TIPS.indexOf("Press {Mod+K} to jump to any channel or conversation.");
    expect(tipAt(quick, true)).toBe("Press ⌘K to jump to any channel or conversation.");
    expect(tipAt(quick, false)).toBe("Press Ctrl+K to jump to any channel or conversation.");
    expect(tipAt(TIPS.findIndex(t => t.includes("{Alt+ArrowUp}")), true)).toBe("⌥↑ and ⌥↓ move between the channels of a server.");
  });

  it("leave no raw key token or Ctrl on macOS", () => {
    for (let i = 0; i < TIPS.length; i++) expect(tipAt(i, true)).not.toMatch(/[{}]|Ctrl/);
  });
});
