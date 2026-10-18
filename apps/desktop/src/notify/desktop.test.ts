import { describe, expect, it, vi } from "vitest";
import { createClickRouter } from "./desktop";

describe("createClickRouter", () => {
  it("routes a click to its own notification, once", () => {
    const router = createClickRouter(10);
    const general = vi.fn();
    const dm = vi.fn();
    const ids = [router.add(general), router.add(dm)];
    expect(ids).toEqual([10, 11]);
    expect(router.click(11)).toBe(true);
    expect(dm).toHaveBeenCalledOnce();
    expect(general).not.toHaveBeenCalled();
    expect(router.click(11)).toBe(false);
    expect(dm).toHaveBeenCalledOnce();
  });

  it("ignores ids it never handed out", () => {
    expect(createClickRouter(10).click(99)).toBe(false);
  });

  it("forgets the oldest notifications past the cap", () => {
    const router = createClickRouter(1, 2);
    const first = vi.fn();
    const ids = [router.add(first), router.add(vi.fn()), router.add(vi.fn())];
    expect(router.click(ids[0])).toBe(false);
    expect(first).not.toHaveBeenCalled();
    expect(router.click(ids[2])).toBe(true);
  });

  it("wraps around before leaving the i32 range the plugin takes", () => {
    const router = createClickRouter(2 ** 31 - 1);
    expect(router.add(vi.fn())).toBe(2 ** 31 - 1);
    expect(router.add(vi.fn())).toBe(1);
  });
});
