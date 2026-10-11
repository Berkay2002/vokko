import { describe, expect, it } from "vitest";
import {
  BACKGROUND_LIMITS,
  BUILTIN_BACKGROUNDS,
  NO_BACKGROUND,
  UPLOAD_REFUSAL,
  builtinById,
  fitScale,
  parseBackground,
  planUpload,
  serializeBackground,
  type BackgroundChoice,
} from "./backgrounds";

const MiB = 1024 * 1024;
const image = (size: number) => ({ type: "image/png", size });

describe("serialize / parse", () => {
  it("round-trips every kind", () => {
    const choices: BackgroundChoice[] = [
      { kind: "none" },
      { kind: "blur", strength: "light" },
      { kind: "blur", strength: "strong" },
      ...BUILTIN_BACKGROUNDS.map(b => ({ kind: "builtin", id: b.id }) as BackgroundChoice),
      { kind: "custom", id: "abc123" },
    ];
    for (const c of choices) expect(parseBackground(serializeBackground(c))).toEqual(c);
  });

  it("serializes to the documented strings", () => {
    expect(serializeBackground({ kind: "none" })).toBe("none");
    expect(serializeBackground({ kind: "blur", strength: "light" })).toBe("blur-light");
    expect(serializeBackground({ kind: "blur", strength: "strong" })).toBe("blur-strong");
    expect(serializeBackground({ kind: "builtin", id: "dusk" })).toBe("builtin:dusk");
    expect(serializeBackground({ kind: "custom", id: "x1" })).toBe("custom:x1");
  });

  it("parses unknown strings to none", () => {
    for (const raw of ["", "garbage", "blur", "blur-medium", "builtin:nope", "builtin:", "custom:", ":dusk", "other:dusk", "BLUR-LIGHT"]) {
      expect(parseBackground(raw)).toEqual(NO_BACKGROUND);
    }
  });

  it("keeps colons inside a custom id", () => {
    expect(parseBackground("custom:a:b")).toEqual({ kind: "custom", id: "a:b" });
  });
});

describe("builtins", () => {
  it("have unique ids and are found by id", () => {
    const ids = BUILTIN_BACKGROUNDS.map(b => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(builtinById("dusk")?.label).toBe("Dusk");
    expect(builtinById("nope")).toBeUndefined();
  });
});

describe("planUpload", () => {
  it("accepts a small image into an empty library", () => {
    expect(planUpload([], image(1 * MiB))).toEqual({ ok: true });
  });

  it("accepts a file of exactly 10 MiB and refuses one byte more", () => {
    expect(planUpload([], image(10 * MiB))).toEqual({ ok: true });
    expect(planUpload([], image(10 * MiB + 1))).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses non-images", () => {
    expect(planUpload([], { type: "application/pdf", size: 10 })).toEqual({ ok: false, reason: "not_image" });
    expect(planUpload([], { type: "", size: 10 })).toEqual({ ok: false, reason: "not_image" });
  });

  it("caps the count at 10", () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, size: 1 }));
    expect(planUpload(nine, image(1))).toEqual({ ok: true });
    expect(planUpload([...nine, { id: "n9", size: 1 }], image(1))).toEqual({ ok: false, reason: "limit_reached" });
  });

  it("caps the total at 40 MiB using the stored size", () => {
    const stored = [{ id: "a", size: 30 * MiB }];
    expect(planUpload(stored, image(10 * MiB))).toEqual({ ok: true });
    expect(planUpload(stored, image(10 * MiB), 10 * MiB + 1)).toEqual({ ok: false, reason: "storage_full" });
    // a big pick scaled down to a small stored size still fits
    expect(planUpload([{ id: "a", size: 39 * MiB }], image(10 * MiB), 1 * MiB)).toEqual({ ok: true });
  });

  it("honours custom limits", () => {
    const limits = { ...BACKGROUND_LIMITS, maxCount: 1 };
    expect(planUpload([{ id: "a", size: 1 }], image(1), 1, limits)).toEqual({ ok: false, reason: "limit_reached" });
  });

  it("has a message for every refusal", () => {
    expect(UPLOAD_REFUSAL.not_image).toBe("That file is not an image.");
    expect(UPLOAD_REFUSAL.too_large).toBe("That image is larger than 10 MB.");
    expect(UPLOAD_REFUSAL.limit_reached).toBe("You can keep up to 10 backgrounds. Remove one first.");
    expect(UPLOAD_REFUSAL.storage_full).toBe("There is no room left for backgrounds on this device. Remove one first.");
  });
});

describe("fitScale", () => {
  it("is 1 when the image already fits", () => {
    expect(fitScale(1280, 720)).toBe(1);
    expect(fitScale(1920, 1080)).toBe(1);
  });
  it("scales the longest edge down to maxEdge", () => {
    expect(fitScale(3840, 2160)).toBe(0.5);
    expect(fitScale(1000, 4000, 2000)).toBe(0.5);
  });
  it("never scales up and survives zero", () => {
    expect(fitScale(100, 50)).toBe(1);
    expect(fitScale(0, 0)).toBe(1);
  });
});
