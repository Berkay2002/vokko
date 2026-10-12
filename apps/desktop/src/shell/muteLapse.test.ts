import { describe, expect, it } from "vitest";
import { msUntilLapse } from "./localState";

describe("msUntilLapse", () => {
  it("is null with nothing timed or pending", () => {
    expect(msUntilLapse([], 1000)).toBeNull();
    expect(msUntilLapse([undefined, -1, 900, 1000], 1000)).toBeNull();
  });
  it("waits for the soonest pending mute, a little past it", () => {
    expect(msUntilLapse([5000, -1, 3000, 800], 1000)).toBe(2050);
  });
  it("stays inside the 32-bit timer limit", () => expect(msUntilLapse([1000 + 2 ** 40], 1000)).toBe(2 ** 31 - 1));
});
