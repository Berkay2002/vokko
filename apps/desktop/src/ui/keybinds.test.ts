import { afterEach, describe, expect, it, vi } from "vitest";
import { BINDINGS, registerShortcut, setKeyOverrides } from "../keyboard";
import { handleKeyDown } from "../keyboard/dispatch";
import {
  DEFAULT_KEYBINDS,
  KEYBIND_ACTIONS,
  actionForKeys,
  applyKeybinds,
  effectiveKeybinds,
  eventKeys,
  findConflicts,
  keysToSpec,
  normalizeKeys,
  runKeybindAction,
  specToKeys,
  toAccelerator,
} from "./keybinds";

const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
const event = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  ({ ...key(k, mods), repeat: false, isComposing: false, keyCode: 0, target: null, defaultPrevented: false, preventDefault: vi.fn() }) as unknown as KeyboardEvent;
const env = { mac: false, modalOpen: () => false };

afterEach(() => setKeyOverrides(null));

describe("keybinds", () => {
  it("normalizes key combinations and key events the same way", () => {
    expect(normalizeKeys("shift+ctrl+k")).toBe("Ctrl+Shift+K");
    expect(normalizeKeys("Cmd+K")).toBe("Ctrl+K");
    expect(eventKeys(key("k", { metaKey: true }))).toBe("Ctrl+K");
    expect(eventKeys(key("ArrowUp", { altKey: true, ctrlKey: true }))).toBe("Ctrl+Alt+ArrowUp");
    expect(eventKeys(key("Shift", { shiftKey: true }))).toBeNull();
  });

  it("has one action per table binding, two for an Up/Down pair", () => {
    const ids = KEYBIND_ACTIONS.map(a => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["quickSwitcher", "channel.up", "channel.down", "mute", "settings", "streamerMode"]));
    expect(KEYBIND_ACTIONS.length).toBe(BINDINGS.reduce((n, b) => n + Math.max(1, b.keys.length), 0));
    expect(DEFAULT_KEYBINDS).toContainEqual({ action: "server.down", keys: "Ctrl+Alt+ArrowDown" });
    expect(DEFAULT_KEYBINDS.some(b => b.action === "streamerMode")).toBe(false);
    expect(specToKeys("Mod+Shift+M")).toBe("Ctrl+Shift+M");
    expect(keysToSpec("Ctrl+Shift+M")).toBe("Mod+Shift+M");
  });

  it("uses the defaults until the user stores a list, then only that list, mapping the first build's action ids", () => {
    expect(effectiveKeybinds([])).toEqual(DEFAULT_KEYBINDS);
    expect(actionForKeys(effectiveKeybinds([]), "Ctrl+K")).toBe("quickSwitcher");
    const mine = [{ action: "quick-switcher", keys: "Ctrl+J" }];
    expect(actionForKeys(effectiveKeybinds(mine), "Ctrl+K")).toBeNull();
    expect(actionForKeys(effectiveKeybinds(mine), "ctrl+j")).toBe("quickSwitcher");
    // Unknown actions are ignored.
    expect(effectiveKeybinds([{ action: "nope", keys: "Ctrl+X" }])).toEqual([]);
  });

  it("drives the shortcut dispatcher: rebound keys fire, the old ones stop", () => {
    let ran = 0;
    const stop = registerShortcut("quickSwitcher", () => void (ran += 1));
    handleKeyDown(event("k", { ctrlKey: true }), env);
    expect(ran).toBe(1);
    applyKeybinds([{ action: "quickSwitcher", keys: "Ctrl+J" }]);
    handleKeyDown(event("k", { ctrlKey: true }), env);
    expect(ran).toBe(1);
    handleKeyDown(event("j", { ctrlKey: true }), env);
    expect(ran).toBe(2);
    applyKeybinds([]);
    handleKeyDown(event("k", { ctrlKey: true }), env);
    expect(ran).toBe(3);
    stop();
  });

  it("gives each half of an Up/Down pair its own index", () => {
    const seen: number[] = [];
    const stop = registerShortcut("channel", i => void seen.push(i));
    applyKeybinds([
      { action: "channel.up", keys: "Alt+K" },
      { action: "channel.down", keys: "Alt+J" },
    ]);
    handleKeyDown(event("j", { altKey: true }), env);
    handleKeyDown(event("k", { altKey: true }), env);
    expect(seen).toEqual([1, 0]);
    stop();
  });

  it("finds binds that share keys", () => {
    const conflicts = findConflicts([
      { action: "inbox", keys: "Ctrl+I" },
      { action: "mute", keys: "ctrl+i" },
      { action: "deafen", keys: "Ctrl+D" },
    ]);
    expect([...conflicts.keys()].sort()).toEqual([0, 1]);
    expect(conflicts.get(0)).toEqual([1]);
  });

  it("turns binds into OS accelerators where the OS can bind them", () => {
    expect(toAccelerator("Ctrl+Shift+M")).toBe("CommandOrControl+Shift+M");
    expect(toAccelerator("Ctrl+/")).toBe("CommandOrControl+Slash");
    expect(toAccelerator("Alt+ArrowUp")).toBe("Alt+ArrowUp");
    expect(toAccelerator("Ctrl+é")).toBeNull();
  });

  it("runs an action through the shortcut handlers and reports unhandled ones", () => {
    let ran = 0;
    const stop = registerShortcut("mute", () => void (ran += 1));
    const declines = registerShortcut("markChannelRead", () => false);
    expect(runKeybindAction("mute")).toBe(true);
    expect(runKeybindAction("toggle-mute")).toBe(true); // first build's id
    expect(runKeybindAction("markChannelRead")).toBe(false);
    expect(runKeybindAction("nope")).toBe(false);
    stop();
    declines();
    expect(runKeybindAction("mute")).toBe(false);
    expect(ran).toBe(2);
  });
});
