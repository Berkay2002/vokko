import { describe, expect, it } from "vitest";
import { untilLabel } from "./localState";

const now = new Date(2026, 9, 12, 14, 0).getTime(); // local time, so the test does not depend on the timezone
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime();

describe("untilLabel", () => {
  it("shows only the time for today", () => {
    expect(untilLabel(at(2026, 9, 12, 23, 30), now, "en-US")).toBe("Until 11:30 PM");
  });
  it("adds the date for tomorrow, even a few minutes past midnight", () => {
    expect(untilLabel(at(2026, 9, 13, 0, 30), now, "en-US")).toBe("Until Oct 13, 12:30 AM");
    expect(untilLabel(at(2026, 9, 13, 9, 0), now, "en-GB")).toBe("Until 13 Oct, 09:00");
  });
  it("adds the year when it is not the current one", () => {
    expect(untilLabel(at(2027, 0, 2, 9, 0), now, "en-GB")).toBe("Until 2 Jan 2027, 09:00");
  });
});
