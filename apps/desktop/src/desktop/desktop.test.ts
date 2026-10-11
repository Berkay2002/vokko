import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }));
const events = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => core);
vi.mock("@tauri-apps/api/event", () => events);

import { getAutostart, setAutostart } from "./autostart";
import { initDeepLinks, onDeepLink, resetDeepLinks, routeDeepLink, type DeepLink } from "./deeplinks";
import { DEFAULT_DESKTOP_PREFS, getDesktopPrefs, setDesktopPrefs } from "./prefs";
import { listShortcuts, onShortcut, registerShortcut } from "./shortcuts";
import { resetTrayUnread, setTrayUnread } from "./tray";
import { checkForUpdate, initUpdater, restartToUpdate, useDesktopUpdate } from "./updater";

beforeEach(() => {
  core.invoke.mockReset();
  core.isTauri.mockReset();
  events.listen.mockReset();
  resetTrayUnread();
  resetDeepLinks();
  useDesktopUpdate.setState({ status: { state: "disabled" } });
});

afterEach(() => vi.unstubAllGlobals());

describe("outside Tauri (browser build)", () => {
  beforeEach(() => core.isTauri.mockReturnValue(false));

  it("returns fallbacks and never touches IPC", async () => {
    expect(await getDesktopPrefs()).toEqual(DEFAULT_DESKTOP_PREFS);
    expect(await setDesktopPrefs({ closeToTray: false })).toEqual(DEFAULT_DESKTOP_PREFS);
    expect(await getAutostart()).toBe(false);
    expect(await setAutostart(true)).toBe(false);
    await setTrayUnread(true);
    expect(await listShortcuts()).toEqual([]);
    await registerShortcut("ptt", "F13");
    expect(await checkForUpdate()).toEqual({ state: "disabled" });
    await restartToUpdate();
    expect(core.invoke).not.toHaveBeenCalled();
  });

  it("subscriptions are inert", async () => {
    const stop = await initDeepLinks();
    const stopShortcut = await onShortcut(() => undefined);
    const stopUpdater = await initUpdater();
    stop();
    stopShortcut();
    stopUpdater();
    expect(events.listen).not.toHaveBeenCalled();
    expect(core.invoke).not.toHaveBeenCalled();
  });
});

describe("inside Tauri", () => {
  beforeEach(() => {
    core.isTauri.mockReturnValue(true);
    events.listen.mockResolvedValue(() => undefined);
  });

  it("passes prefs patches to the Rust command", async () => {
    core.invoke.mockResolvedValue({ closeToTray: false, startMinimized: true });
    expect(await setDesktopPrefs({ closeToTray: false })).toEqual({ closeToTray: false, startMinimized: true });
    expect(core.invoke).toHaveBeenCalledWith("desktop_set_prefs", { patch: { closeToTray: false } });
  });

  it("surfaces autostart failures to the caller", async () => {
    core.invoke.mockRejectedValue("access denied");
    await expect(setAutostart(true)).rejects.toBe("access denied");
  });

  it("falls back instead of throwing for read-only queries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    core.invoke.mockRejectedValue("boom");
    expect(await getAutostart()).toBe(false);
    warn.mockRestore();
  });

  it("sends the tray unread state only when it changes", async () => {
    core.invoke.mockResolvedValue(undefined);
    await setTrayUnread(true);
    await setTrayUnread(true);
    await setTrayUnread(false);
    expect(core.invoke.mock.calls.map(call => call[1])).toEqual([{ unread: true }, { unread: false }]);
  });

  it("delivers queued deep links after subscribing", async () => {
    const order: string[] = [];
    events.listen.mockImplementation(async () => {
      order.push("listen");
      return () => undefined;
    });
    const link: DeepLink = { kind: "auth", url: "vokko://auth/callback?code=1&state=2" };
    core.invoke.mockImplementation(async (command: string) => {
      order.push(command);
      return [link];
    });
    const seen: DeepLink[] = [];
    onDeepLink(l => seen.push(l));
    const stop = await initDeepLinks();
    expect(order).toEqual(["listen", "desktop_take_pending_links"]);
    expect(seen).toEqual([link]);
    stop();
  });

  it("replays an auth link that arrived before anyone subscribed", async () => {
    const link: DeepLink = { kind: "auth", url: "vokko://auth/callback?code=1&state=2" };
    core.invoke.mockResolvedValue([link]);
    await initDeepLinks();
    const seen: DeepLink[] = [];
    onDeepLink(l => seen.push(l));
    expect(seen).toEqual([link]);
    const later: DeepLink[] = [];
    onDeepLink(l => later.push(l));
    expect(later).toEqual([]);
  });

  it("stops delivering after unsubscribe", async () => {
    let emit: (link: DeepLink) => void = () => undefined;
    events.listen.mockImplementation(async (_name: string, cb: (event: { payload: DeepLink }) => void) => {
      emit = link => cb({ payload: link });
      return () => undefined;
    });
    core.invoke.mockResolvedValue([]);
    await initDeepLinks();
    const seen: DeepLink[] = [];
    const off = onDeepLink(l => seen.push(l));
    emit({ kind: "invite", code: "a", url: "vokko://invite/a" });
    off();
    emit({ kind: "auth", url: "vokko://auth/callback" });
    expect(seen).toEqual([{ kind: "invite", code: "a", url: "vokko://invite/a" }]);
  });

  it("stays off when the build has no updater", async () => {
    core.invoke.mockResolvedValue({ state: "disabled" });
    await initUpdater();
    expect(useDesktopUpdate.getState().status).toEqual({ state: "disabled" });
    expect(core.invoke).toHaveBeenCalledTimes(1);
  });

  it("publishes the status of an update check", async () => {
    core.invoke.mockResolvedValue({ state: "ready", version: "0.2.0" });
    await checkForUpdate();
    expect(core.invoke).toHaveBeenCalledWith("desktop_update_check", { download: true });
    expect(useDesktopUpdate.getState().status).toEqual({ state: "ready", version: "0.2.0" });
  });
});

describe("routeDeepLink", () => {
  it("pushes the invite path and notifies the router", () => {
    const pushState = vi.fn();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { location: { pathname: "/channels/@me" }, history: { pushState }, dispatchEvent });
    vi.stubGlobal("PopStateEvent", class {});
    routeDeepLink({ kind: "invite", code: "abc", url: "vokko://invite/abc" });
    expect(pushState).toHaveBeenCalledWith({}, "", "/invite/abc");
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
});
