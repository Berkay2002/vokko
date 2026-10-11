import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissPrompt, isPromptDismissed, needsPermissionPrompt } from "./Banners";

describe("needsPermissionPrompt", () => {
  it("browser: only while the permission is undecided", () => {
    expect(needsPermissionPrompt("web", "default")).toBe(true);
    expect(needsPermissionPrompt("web", "granted")).toBe(false);
    expect(needsPermissionPrompt("web", "denied")).toBe(false);
  });

  it("desktop shell: the plugin always says granted, so the pref switch is offered anyway", () => {
    expect(needsPermissionPrompt("tauri", "granted")).toBe(true);
    expect(needsPermissionPrompt("tauri", "denied")).toBe(false);
  });
});

describe("permission bar dismissal", () => {
  const stubStorage = () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) });
  };
  afterEach(() => vi.unstubAllGlobals());

  it("persists across loads with no expiry", () => {
    stubStorage();
    expect(isPromptDismissed()).toBe(false);
    dismissPrompt();
    expect(isPromptDismissed()).toBe(true);
  });

  it("falls back to showing the bar when storage is unavailable", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    expect(() => dismissPrompt()).not.toThrow();
    expect(isPromptDismissed()).toBe(false);
  });
});
