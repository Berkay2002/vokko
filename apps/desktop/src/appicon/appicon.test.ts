import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => core);
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { DEFAULT_PREFS, migratePrefs, setPref } from "../ui/prefs";
import "./apply";
import { ICON_URLS } from "./urls";
import { APP_ICONS, DEFAULT_APP_ICON, isAppIconId } from "./variants";

describe("appIcon pref", () => {
  it("defaults to the Vokko icon, which is the first variant", () => {
    expect(DEFAULT_PREFS.appIcon).toBe("default");
    expect(APP_ICONS[0].id).toBe(DEFAULT_APP_ICON);
  });

  it("a saved variant is kept", () => {
    expect(migratePrefs({ appIcon: "flame" }).appIcon).toBe("flame");
  });

  it("an unknown or mistyped value falls back to the default", () => {
    expect(migratePrefs({ appIcon: "nitro-gold" }).appIcon).toBe("default");
    expect(migratePrefs({ appIcon: 3 }).appIcon).toBe("default");
    expect(migratePrefs({}).appIcon).toBe("default");
    expect(isAppIconId("__proto__")).toBe(false);
  });

  it("every variant has an SVG source and the other way round", () => {
    expect(Object.keys(ICON_URLS).sort()).toEqual(APP_ICONS.map(icon => icon.id).sort());
  });
});

describe("applying the icon", () => {
  beforeEach(() => core.invoke.mockClear());

  it("sends a changed choice to the desktop shell once", async () => {
    setPref("appIcon", "galaxy");
    setPref("appIcon", "galaxy");
    await vi.waitFor(() => expect(core.invoke).toHaveBeenCalledTimes(1));
    expect(core.invoke).toHaveBeenCalledWith("desktop_set_app_icon", { id: "galaxy" });
    setPref("appIcon", "default");
    await vi.waitFor(() => expect(core.invoke).toHaveBeenLastCalledWith("desktop_set_app_icon", { id: "default" }));
    expect(core.invoke).toHaveBeenCalledTimes(2);
  });

  it("retries a failed apply on the next pref change", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    core.invoke.mockRejectedValueOnce(new Error("no window"));
    setPref("appIcon", "flame");
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1)); // the failed call is over, nothing is in flight
    warn.mockRestore();
    setPref("theme", "dark"); // any pref change re-runs the apply
    await vi.waitFor(() => expect(core.invoke).toHaveBeenCalledTimes(2));
    expect(core.invoke).toHaveBeenLastCalledWith("desktop_set_app_icon", { id: "flame" });
    setPref("appIcon", "default");
    await vi.waitFor(() => expect(core.invoke).toHaveBeenCalledTimes(3));
  });

  it("is a no-op in the browser build", async () => {
    core.isTauri.mockReturnValue(false);
    setPref("appIcon", "mono");
    await Promise.resolve();
    expect(core.invoke).not.toHaveBeenCalled();
    core.isTauri.mockReturnValue(true);
    setPref("appIcon", "default");
  });
});
