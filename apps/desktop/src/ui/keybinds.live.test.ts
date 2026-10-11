import { afterEach, describe, expect, it, vi } from "vitest";

// A window with only the listener API: every keydown listener the app installs is collected and run, like the browser does.
const listeners: ((e: KeyboardEvent) => void)[] = [];
vi.stubGlobal("window", {
  addEventListener: (type: string, fn: (e: KeyboardEvent) => void) => type === "keydown" && listeners.push(fn),
  removeEventListener: () => undefined,
});

const press = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>>) => {
  const e = { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods, repeat: false, isComposing: false, keyCode: 0, target: null, defaultPrevented: false, preventDefault: () => (e.defaultPrevented = true) };
  for (const fn of listeners) fn(e as unknown as KeyboardEvent);
};

afterEach(() => vi.unstubAllGlobals());

describe("keybinds over the shortcut table", () => {
  it("Ctrl/Cmd+K toggles the quick switcher exactly once with a custom keybind list", async () => {
    const { usePrefs } = await import("./prefs");
    usePrefs.setState({ keybinds: [{ action: "quickSwitcher", keys: "Ctrl+K" }, { action: "mute", keys: "Ctrl+Shift+M" }] });
    await import("./keybindsLive");
    const { registerShortcut } = await import("../keyboard");
    let open = false;
    let runs = 0;
    const stop = registerShortcut("quickSwitcher", () => {
      runs += 1;
      open = !open;
    });
    press("k", { ctrlKey: true });
    expect(runs).toBe(1);
    expect(open).toBe(true);
    // The table's other defaults are off while a custom list is set.
    let inbox = 0;
    const stopInbox = registerShortcut("inbox", () => void (inbox += 1));
    press("i", { ctrlKey: true });
    expect(inbox).toBe(0);
    stop();
    stopInbox();
  });
});
