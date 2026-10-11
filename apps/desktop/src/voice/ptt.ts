// Push-to-talk key: global through the desktop shortcut adapter in Tauri, window keydown/keyup in the browser
// (docs/design/voice.md §3.3, §3.7). Accelerators use the desktop adapter's format: "Ctrl+Shift+K", "Alt+F13", "F13", "`".

import { create } from "zustand";
import { isDesktop, onShortcut, registerShortcut, unregisterShortcut, type ShortcutEvent } from "../desktop";

/** The global-shortcut side of the desktop adapter (injectable for tests). */
export interface ShortcutAdapter {
  isDesktop(): boolean;
  registerShortcut(id: string, accelerator: string): Promise<void>;
  unregisterShortcut(id: string): Promise<void>;
  onShortcut(handler: (event: ShortcutEvent) => void): Promise<() => void>;
}

const desktopAdapter: ShortcutAdapter = { isDesktop, registerShortcut, unregisterShortcut, onShortcut };

/** Every binding gets its own shortcut id, so a late (un)registration of an old binding can never touch a newer one. */
let generation = 0;
/** Register / unregister calls run one after another: an old binding's release of the accelerator finishes before a new
 * binding grabs it again. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}
const MODIFIERS = ["Ctrl", "Alt", "Shift", "Super"] as const;

/** Why the OS refused the global Push to Talk shortcut (null while it works or nothing is bound). */
export const usePttGlobal = create<{ refused: string | null }>(() => ({ refused: null }));

/** A sentence for the settings page; `reason` is whatever the OS or the plugin said. */
export function refusalNote(reason: string): string {
  const detail = reason.trim();
  return `Your system did not allow this shortcut${detail ? ` (${detail})` : ""}; another app may be using it. Push to Talk will only work while Vokko is focused. Pick another key to use it everywhere.`;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : typeof error === "string" ? error : "");

/**
 * Tries to claim `accelerator` globally for a moment, so the settings page can warn right after a key is recorded instead of
 * when the user next joins a call. Resolves to a note when the OS refuses, null when it works (or in the browser).
 */
export async function probeShortcut(accelerator: string, adapter: ShortcutAdapter = desktopAdapter): Promise<string | null> {
  if (!adapter.isDesktop()) return null;
  const id = `voice-ptt-probe-${(generation += 1)}`;
  return serial(async () => {
    try {
      await adapter.registerShortcut(id, accelerator);
    } catch (error) {
      return refusalNote(reasonOf(error));
    }
    await adapter.unregisterShortcut(id).catch(() => undefined);
    return null;
  });
}

interface KeyLike {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** Main (non-modifier) key name from a KeyboardEvent code: KeyA → A, Digit1 → 1, F13, Space, Backquote → `. */
export function keyName(code: string, key: string): string | null {
  if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code)) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  if (/^Numpad\d$/.test(code)) return `Num${code.slice(6)}`;
  const named: Record<string, string> = { Backquote: "`", Space: "Space", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", CapsLock: "CapsLock", Tab: "Tab", Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Pause: "Pause", ScrollLock: "ScrollLock" };
  if (named[code]) return named[code] ?? null;
  return key.length === 1 ? key.toUpperCase() : code || null;
}

/** "Ctrl+Shift+K" for a key press, or null for a bare modifier. */
export function acceleratorFromEvent(event: KeyLike): string | null {
  const main = keyName(event.code, event.key);
  if (!main) return null;
  const mods = [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Super"].filter((m): m is string => !!m);
  return [...mods, main].join("+");
}

function parse(accelerator: string): { mods: Set<string>; main: string } {
  const parts = accelerator.split("+").filter(Boolean);
  // "Ctrl++" style is not produced by acceleratorFromEvent; a trailing empty part means the key itself is "+".
  const main = accelerator.endsWith("++") ? "+" : (parts.pop() ?? "");
  return { mods: new Set(parts.filter(p => (MODIFIERS as readonly string[]).includes(p))), main };
}

/** Whether a keydown matches the binding (exact modifiers). */
export function matchesDown(accelerator: string, event: KeyLike): boolean {
  return acceleratorFromEvent(event) === accelerator;
}

/** Keyup of the binding's main key ends PTT regardless of modifiers (they may already be up). */
export function matchesUp(accelerator: string, event: KeyLike): boolean {
  return keyName(event.code, event.key) === parse(accelerator).main;
}

export const hasModifier = (accelerator: string): boolean => parse(accelerator).mods.size > 0;

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

/** Binds the PTT key; `onChange(true)` on press, `onChange(false)` on release. Returns the unbind function. */
export function bindPtt(accelerator: string, onChange: (pressed: boolean) => void, adapter: ShortcutAdapter = desktopAdapter): () => void {
  let pressed = false;
  const set = (on: boolean) => {
    if (on === pressed) return;
    pressed = on;
    onChange(on);
  };
  let stopped = false;
  let inWindow = false;
  const shortcutId = `voice-ptt-${(generation += 1)}`;

  const down = (event: KeyboardEvent) => {
    if (event.repeat || !matchesDown(accelerator, event)) return;
    if (isTyping(event.target) && !hasModifier(accelerator)) return;
    set(true);
  };
  const up = (event: KeyboardEvent) => {
    if (matchesUp(accelerator, event)) set(false);
  };
  const blur = () => set(false);
  const listenInWindow = () => {
    if (stopped || inWindow) return;
    inWindow = true;
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
  };

  // Global binding lifecycle, serialized with every other binding's: register → listen → (on unbind) unlisten → unregister.
  let global: Promise<(() => void) | null> = Promise.resolve(null);
  if (adapter.isDesktop()) {
    global = serial(async () => {
      if (stopped) return null;
      try {
        await adapter.registerShortcut(shortcutId, accelerator);
        if (!stopped) usePttGlobal.setState({ refused: null });
      } catch (error) {
        // Taken by another app or not supported (e.g. Wayland): in-window only, and say so in the settings.
        if (!stopped) usePttGlobal.setState({ refused: refusalNote(reasonOf(error)) });
        listenInWindow();
        return null;
      }
      try {
        return await adapter.onShortcut(event => {
          if (!stopped && event.id === shortcutId) set(event.state === "pressed");
        });
      } catch {
        // Registered but no event channel: release the accelerator again and fall back to the window.
        await adapter.unregisterShortcut(shortcutId).catch(() => undefined);
        listenInWindow();
        return null;
      }
    });
  } else {
    listenInWindow();
  }

  return () => {
    if (stopped) return;
    stopped = true;
    usePttGlobal.setState({ refused: null });
    if (inWindow) {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
    }
    // Queued now (not when the registration settles), so a binding made after this unbind registers after this release.
    void serial(async () => {
      const unlisten = await global;
      if (!unlisten) return;
      unlisten();
      await adapter.unregisterShortcut(shortcutId);
    }).catch(() => undefined);
    set(false);
  };
}
