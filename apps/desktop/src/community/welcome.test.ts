import { beforeEach, describe, expect, it } from "vitest";
import { NEW_SERVER_DAYS, isNewServerOwner, useWelcome } from "./welcome";

const DAY = 24 * 60 * 60 * 1000;

describe("isNewServerOwner", () => {
  const now = Date.UTC(2026, 9, 11);
  it("is for the owner of a recent server only", () => {
    expect(isNewServerOwner(now - DAY, "1", "1", now)).toBe(true);
    expect(isNewServerOwner(now - (NEW_SERVER_DAYS + 1) * DAY, "1", "1", now)).toBe(false);
    expect(isNewServerOwner(now - DAY, "1", "2", now)).toBe(false);
    expect(isNewServerOwner(now - DAY, "1", undefined, now)).toBe(false);
  });
});

describe("welcome progress", () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) },
    });
    useWelcome.setState({ progress: {} });
  });

  it("merges changes and persists them", () => {
    useWelcome.getState().mark("5", { invited: true });
    useWelcome.getState().mark("5", { app: true });
    expect(useWelcome.getState().progress["5"]).toEqual({ invited: true, app: true });
    expect(JSON.parse(localStorage.getItem("vokko.welcome.5") ?? "{}")).toEqual({ invited: true, app: true });
    useWelcome.setState({ progress: {} });
    useWelcome.getState().mark("5", { dismissed: true });
    expect(useWelcome.getState().progress["5"]).toEqual({ invited: true, app: true, dismissed: true });
  });

  it("survives a broken storage", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(() => useWelcome.getState().mark("6", { dismissed: true })).not.toThrow();
    expect(useWelcome.getState().progress["6"]).toEqual({ dismissed: true });
  });
});
