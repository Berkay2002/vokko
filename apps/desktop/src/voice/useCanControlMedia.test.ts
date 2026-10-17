import { describe, expect, it } from "vitest";
import { DEFAULT_EVERYONE, Perm } from "../api/permissions";
import { canControlMedia, queueQuota, skipAction } from "./useCanControlMedia";

const control = { host_id: "1", added_by: "2", skip_votes: ["3"], skip_needed: 2, item_seq: 0 };

describe("canControlMedia", () => {
  it("is true in a DM call, with CONTROL_MEDIA, or for the host", () => {
    expect(canControlMedia({ dm: true, bits: 0n, meId: "9", hostId: "1" })).toBe(true);
    expect(canControlMedia({ dm: false, bits: DEFAULT_EVERYONE, meId: "9", hostId: "1" })).toBe(true);
    expect(canControlMedia({ dm: false, bits: DEFAULT_EVERYONE & ~Perm.CONTROL_MEDIA, meId: "9", hostId: "1" })).toBe(false);
    expect(canControlMedia({ dm: false, bits: 0n, meId: "1", hostId: "1" })).toBe(true);
    expect(canControlMedia({ dm: false, bits: 0n, meId: undefined, hostId: undefined })).toBe(false);
  });
});

describe("skipAction", () => {
  it("skips for a controller and the adder, votes for everyone else", () => {
    expect(skipAction(control, "1", true)).toEqual({ label: "Skip, 1 voted", vote: false, voted: false, skip: true });
    expect(skipAction({ ...control, skip_votes: [] }, "2", false, "Skip to next")).toMatchObject({ label: "Skip to next", vote: false, skip: true });
    expect(skipAction(control, "4", false)).toEqual({ label: "Vote to skip (1/2)", vote: true, voted: false, skip: true });
    expect(skipAction(control, "3", false)).toEqual({ label: "Vote to skip (1/2)", vote: true, voted: true, skip: false });
  });
});

describe("queueQuota", () => {
  it("counts a non-controller's own entries; a controller has none", () => {
    expect(queueQuota(["4", "5", "4"], "4", false, 3)).toEqual({ mine: 2, full: false, hint: "2 of 3 added" });
    expect(queueQuota(["4", "4", "4"], "4", false, 3)?.full).toBe(true);
    expect(queueQuota(["4"], "4", true, 3)).toBeNull();
  });
});
