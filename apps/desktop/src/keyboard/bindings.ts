// The one table of in-app keyboard shortcuts. The dispatcher matches key events against it, the shortcuts dialog renders it,
// and each call site registers what a binding does with useShortcut(id, handler).
// "Mod" is Cmd on macOS and Ctrl elsewhere, like Discord; "Alt" is Option on macOS.

import { keysFor } from "./overrides";

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export type ShortcutGroup = "Navigation" | "Unreads" | "Chat" | "Voice" | "Panels";

export interface Binding {
  id: string;
  group: ShortcutGroup;
  label: string;
  /** Alternatives; the handler gets the index that matched (Up/Down pairs: 0 = up, 1 = down). */
  keys: readonly string[];
  /** Fires on key auto-repeat (navigation). Toggles never do. */
  repeat?: boolean;
  /** In a text field: "any" (default), "composer" (only the message composer and its emoji/GIF/sticker picker; other fields keep the key, e.g. Option+Up caret moves) or "none". */
  text?: "any" | "composer" | "none";
  /** Fires while a modal is open (the toggles that open or close one). */
  modal?: boolean;
}

export const BINDINGS = [
  { id: "quickSwitcher", group: "Navigation", label: "Quick switcher", keys: ["Mod+K"], modal: true },
  { id: "channel", group: "Navigation", label: "Navigate between channels", keys: ["Alt+ArrowUp", "Alt+ArrowDown"], repeat: true, text: "composer" },
  { id: "server", group: "Navigation", label: "Navigate between servers", keys: ["Mod+Alt+ArrowUp", "Mod+Alt+ArrowDown"], repeat: true, text: "composer" },
  { id: "unreadChannel", group: "Navigation", label: "Navigate unread channels", keys: ["Alt+Shift+ArrowUp", "Alt+Shift+ArrowDown"], repeat: true, text: "composer" },
  {
    id: "mentionChannel",
    group: "Navigation",
    label: "Navigate unread channels with mentions",
    keys: ["Mod+Shift+Alt+ArrowUp", "Mod+Shift+Alt+ArrowDown"],
    repeat: true,
    text: "composer",
  },
  { id: "createServer", group: "Navigation", label: "Create or join a server", keys: ["Mod+Shift+N"] },
  { id: "nextRegion", group: "Navigation", label: "Move to the next area (servers, channels, chat, members)", keys: ["F6"] },
  { id: "previousRegion", group: "Navigation", label: "Move to the previous area", keys: ["Shift+F6"] },
  { id: "markChannelRead", group: "Unreads", label: "Mark channel as read", keys: ["Escape"], text: "composer" },
  { id: "markServerRead", group: "Unreads", label: "Mark server as read", keys: ["Shift+Escape"], text: "composer" },
  { id: "oldestUnread", group: "Unreads", label: "Jump to oldest unread message", keys: ["Shift+PageUp"], text: "composer" },
  { id: "focusComposer", group: "Chat", label: "Focus text area", keys: ["Tab"], text: "none" },
  { id: "editLast", group: "Chat", label: "Edit your last message", keys: ["ArrowUp"], text: "composer" },
  { id: "upload", group: "Chat", label: "Upload a file", keys: ["Mod+Shift+U"] },
  { id: "emoji", group: "Chat", label: "Toggle emoji picker", keys: ["Mod+E"], text: "composer" },
  { id: "gif", group: "Chat", label: "Toggle GIF picker", keys: ["Mod+G"], text: "composer" },
  { id: "sticker", group: "Chat", label: "Toggle sticker picker", keys: ["Mod+S"], text: "composer" },
  { id: "mute", group: "Voice", label: "Toggle mute", keys: ["Mod+Shift+M"] },
  { id: "deafen", group: "Voice", label: "Toggle deafen", keys: ["Mod+Shift+D"] },
  { id: "inbox", group: "Panels", label: "Toggle inbox", keys: ["Mod+I"], modal: true },
  { id: "pins", group: "Panels", label: "Toggle pinned messages", keys: ["Mod+P"] },
  { id: "members", group: "Panels", label: "Toggle member list", keys: ["Mod+U"] },
  { id: "shortcuts", group: "Panels", label: "Toggle keyboard shortcuts", keys: ["Mod+/"], modal: true },
  { id: "settings", group: "Panels", label: "Open user settings", keys: ["Mod+,"] },
  // Unbound out of the box: runs only once the user gives it keys in Settings > Keybinds.
  { id: "streamerMode", group: "Panels", label: "Toggle streamer mode", keys: [] },
] as const satisfies readonly Binding[];

export type ShortcutId = (typeof BINDINGS)[number]["id"];

interface Chord {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

function parse(spec: string): Chord {
  const parts = spec.split("+");
  const key = parts.pop() ?? "";
  return { mod: parts.includes("Mod"), alt: parts.includes("Alt"), shift: parts.includes("Shift"), key: key.length === 1 ? key.toLowerCase() : key };
}

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

/** Exact match: on macOS Mod is Cmd and a held Ctrl spoils it; elsewhere Mod is Ctrl and a held Meta spoils it. */
export function matches(spec: string, e: KeyLike, mac: boolean): boolean {
  const c = parse(spec);
  const mod = mac ? e.metaKey : e.ctrlKey;
  const other = mac ? e.ctrlKey : e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return mod === c.mod && !other && e.altKey === c.alt && e.shiftKey === c.shift && key === c.key;
}

/** Index of the first of `binding.keys` that `e` matches, or -1. */
export function matchIndex(binding: Pick<Binding, "keys">, e: KeyLike, mac: boolean): number {
  return binding.keys.findIndex(spec => matches(spec, e, mac));
}

const MAC_CAPS: Record<string, string> = { Mod: "⌘", Alt: "⌥", Shift: "⇧" };
const PC_CAPS: Record<string, string> = { Mod: "Ctrl" };
const KEY_CAPS: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", Escape: "Esc", PageUp: "Page Up" };

/** Key caps for one spec as the OS labels them: ["⌘", "K"] on macOS, ["Ctrl", "K"] elsewhere. */
export function keyCaps(spec: string, mac: boolean): string[] {
  const parts = spec.split("+");
  const key = parts.pop() ?? "";
  const mods = parts.map(m => (mac ? MAC_CAPS : PC_CAPS)[m] ?? m);
  return [...mods, KEY_CAPS[key] ?? (key.length === 1 ? key.toUpperCase() : key)];
}

/** Groups in display order: the shortcuts dialog and Settings > Keybinds list them the same way. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ["Navigation", "Unreads", "Chat", "Voice", "Panels"];

/** Caps of a binding; an Up/Down pair shows its shared modifiers once, then both arrows: ⌥ + ↑ ↓. */
export function bindingCaps(b: Pick<Binding, "keys">, mac: boolean): string[] {
  const caps = keyCaps(b.keys[0]!, mac);
  if (b.keys.length < 2) return caps;
  return [...caps.slice(0, -1), b.keys.map(k => keyCaps(k, mac).at(-1)).join(" ")];
}

export interface ShortcutRow {
  id: string;
  action: string;
  keys: string[];
}

/** The binding table by group, with the keys this OS shows. */
export function bindingGroups(mac: boolean = IS_MAC): { title: ShortcutGroup; binds: ShortcutRow[] }[] {
  return SHORTCUT_GROUPS.map(title => ({
    title,
    // The keys in force: the user's keybinds (Settings > Keybinds) when set; a binding without keys is left out.
    binds: (BINDINGS as readonly Binding[])
      .filter(b => b.group === title)
      .map(b => ({ b, keys: keysFor(b).map(k => k.spec) }))
      .filter(({ keys }) => keys.length > 0)
      .map(({ b, keys }) => ({ id: b.id, action: b.label, keys: bindingCaps({ keys }, mac) })),
  }));
}
