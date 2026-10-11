// Keybinds (Settings > Keybinds): the user's list (synced pref `keybinds`) over the one shortcut table, src/keyboard/bindings.ts.
// Every binding of that table is an action here (Up/Down pairs are two actions, "<id>.up" and "<id>.down"); a stored list replaces the
// table's keys (`applyKeybinds` → src/keyboard/overrides.ts), and binds marked global are also registered with the OS (keybindsLive.ts).
// Stored keys use "Ctrl" for the platform modifier (Cmd on macOS), so a list synced from Windows works on a Mac.

import { BINDINGS, runShortcut, setKeyOverrides, type Binding, type BoundKey, type ShortcutGroup, type ShortcutId } from "../keyboard";
import type { KeybindPref } from "./prefs";

const MODIFIERS = ["Ctrl", "Alt", "Shift"] as const;
const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph", "OS"]);

export interface KeybindAction {
  id: string;
  label: string;
  group: ShortcutGroup;
  /** Keys bound out of the box; null = the action only runs when the user binds it. */
  defaultKeys: string | null;
  shortcut: ShortcutId;
  /** Handler index of the binding (Up/Down pairs: 0 = up, 1 = down). */
  index: number;
}

/** Table spec ("Mod+Alt+ArrowUp") → stored keys ("Ctrl+Alt+ArrowUp"). */
export function specToKeys(spec: string): string {
  return normalizeKeys(spec.split("+").map(p => (p === "Mod" ? "Ctrl" : p)).join("+"));
}

/** Stored keys → table spec; null for keys the table cannot express. */
export function keysToSpec(keys: string): string | null {
  const parts = normalizeKeys(keys).split("+");
  const key = parts.pop() ?? "";
  if (!key || key === "+") return null;
  return [...parts.map(p => (p === "Ctrl" ? "Mod" : p)), key === "Space" ? " " : key].join("+");
}

const PAIR = ["up", "down"] as const;

/** Every keyboard action, in the table's order. */
export const KEYBIND_ACTIONS: readonly KeybindAction[] = (BINDINGS as readonly Binding[]).flatMap(b =>
  b.keys.length > 1
    ? b.keys.map((spec, i) => ({
        id: `${b.id}.${PAIR[i] ?? i}`,
        label: `${b.label} (${PAIR[i] ?? i})`,
        group: b.group,
        defaultKeys: specToKeys(spec),
        shortcut: b.id as ShortcutId,
        index: i,
      }))
    : [{ id: b.id, label: b.label, group: b.group, defaultKeys: b.keys[0] ? specToKeys(b.keys[0]) : null, shortcut: b.id as ShortcutId, index: 0 }],
);

/** Action ids of the first keybinds build (before the shared table), so lists stored by it keep working. */
const LEGACY: Record<string, string> = {
  "quick-switcher": "quickSwitcher",
  "prev-channel": "channel.up",
  "next-channel": "channel.down",
  "prev-server": "server.up",
  "next-server": "server.down",
  "create-server": "createServer",
  "open-inbox": "inbox",
  "toggle-members": "members",
  "mark-channel-read": "markChannelRead",
  "mark-server-read": "markServerRead",
  "toggle-mute": "mute",
  "toggle-deafen": "deafen",
  "show-shortcuts": "shortcuts",
  "open-settings": "settings",
  "toggle-streamer-mode": "streamerMode",
};

export const actionById = (id: string): KeybindAction | undefined => KEYBIND_ACTIONS.find(a => a.id === (LEGACY[id] ?? id));

export const DEFAULT_KEYBINDS: readonly KeybindPref[] = KEYBIND_ACTIONS.filter(a => a.defaultKeys).map(a => ({ action: a.id, keys: a.defaultKeys as string }));

/** The binds in force: the defaults until the user edits anything, then the user's full list (old action ids mapped). */
export function effectiveKeybinds(stored: readonly KeybindPref[]): KeybindPref[] {
  if (stored.length === 0) return [...DEFAULT_KEYBINDS];
  return stored.flatMap(b => {
    const action = actionById(b.action);
    return action && b.keys ? [{ ...b, action: action.id }] : [];
  });
}

/**
 * Keys the user may bind to `actionId`: a bare or Shift-only key would be swallowed in every text field (and sync to every device),
 * so it needs Ctrl/Cmd or Alt. Function keys and the action's own default (Escape, Tab, ArrowUp) are fine.
 */
export function canBindKeys(keys: string, actionId: string): boolean {
  const parts = normalizeKeys(keys).split("+");
  const key = parts[parts.length - 1] ?? "";
  if (parts.includes("Ctrl") || parts.includes("Alt") || /^F([1-9]|1\d|2[0-4])$/.test(key)) return true;
  const def = actionById(actionId)?.defaultKeys;
  return !!def && normalizeKeys(def) === normalizeKeys(keys);
}

/** Lays the user's list over the shortcut table (an empty list = the table's own keys). */
export function applyKeybinds(stored: readonly KeybindPref[]): void {
  if (stored.length === 0) {
    setKeyOverrides(null);
    return;
  }
  const map = new Map<ShortcutId, BoundKey[]>();
  for (const bind of effectiveKeybinds(stored)) {
    const action = actionById(bind.action);
    const spec = keysToSpec(bind.keys);
    // A bare key stored by an older build or another device is ignored rather than eating typed text.
    if (!action || !spec || !canBindKeys(bind.keys, action.id)) continue;
    map.set(action.shortcut, [...(map.get(action.shortcut) ?? []), { spec, index: action.index }]);
  }
  setKeyOverrides(map);
}

/** Canonical form of a key combination: modifiers in Ctrl, Alt, Shift order, a single letter upper-cased. */
export function normalizeKeys(keys: string): string {
  const parts = keys.split("+").map(p => p.trim()).filter(Boolean);
  // "Ctrl++" (plus key) splits into an empty tail: keep the key.
  if (keys.endsWith("++")) parts.push("+");
  const mods = MODIFIERS.filter(m => parts.some(p => p.toLowerCase() === m.toLowerCase() || (m === "Ctrl" && /^(cmd|meta|control|mod)$/i.test(p))));
  const key = parts.filter(p => !MODIFIERS.some(m => m.toLowerCase() === p.toLowerCase()) && !/^(cmd|meta|control|mod)$/i.test(p)).pop() ?? "";
  const shown = key.length === 1 ? key.toUpperCase() : key;
  return [...mods, shown].filter(Boolean).join("+");
}

/** Keys of a keyboard event ("Ctrl+Shift+K"); null while only modifiers are down. Cmd on macOS counts as Ctrl. */
export function eventKeys(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const mods = [(event.ctrlKey || event.metaKey) && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift"].filter((m): m is string => !!m);
  const key = event.key === " " ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  // Shift changes the produced character ("?" for "/"): the bind is stored with the key the event reports, which is what matches later.
  return normalizeKeys([...mods, key].join("+"));
}

/** Pairs of binds (indexes) that use the same keys. */
export function findConflicts(binds: readonly KeybindPref[]): Map<number, number[]> {
  const byKeys = new Map<string, number[]>();
  binds.forEach((b, i) => {
    const k = normalizeKeys(b.keys).toLowerCase();
    byKeys.set(k, [...(byKeys.get(k) ?? []), i]);
  });
  const out = new Map<number, number[]>();
  for (const list of byKeys.values()) if (list.length > 1) for (const i of list) out.set(i, list.filter(j => j !== i));
  return out;
}

/** The action bound to these keys (first match). */
export function actionForKeys(binds: readonly KeybindPref[], keys: string): string | null {
  const wanted = normalizeKeys(keys).toLowerCase();
  return binds.find(b => normalizeKeys(b.keys).toLowerCase() === wanted)?.action ?? null;
}

/** Tauri accelerator for an OS-wide shortcut ("Ctrl+Shift+K" → "CommandOrControl+Shift+K"); null for keys the OS APIs can't bind. */
export function toAccelerator(keys: string): string | null {
  const parts = normalizeKeys(keys).split("+");
  const key = parts.pop() ?? "";
  const names: Record<string, string> = { "/": "Slash", ",": "Comma", ".": "Period", ";": "Semicolon", "'": "Quote", "[": "BracketLeft", "]": "BracketRight", "-": "Minus", "=": "Equal", "`": "Backquote", "\\": "Backslash" };
  const mapped = /^[A-Z0-9]$/.test(key) ? key : names[key] ?? (/^(F\d{1,2}|Arrow(Up|Down|Left|Right)|Escape|Space|Enter|Tab|Home|End|PageUp|PageDown|Insert|Delete|Backspace)$/.test(key) ? key : null);
  if (!mapped) return null;
  return [...parts.map(p => (p === "Ctrl" ? "CommandOrControl" : p)), mapped].join("+");
}

/** Runs an action from outside the key dispatcher (an OS-wide shortcut). Returns whether a handler took it. */
export function runKeybindAction(id: string, event?: KeyboardEvent): boolean {
  const action = actionById(id);
  return action ? runShortcut(action.shortcut, action.index, event) : false;
}
