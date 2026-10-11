// The user's keybinds (Settings > Keybinds, synced pref `keybinds`) laid over the binding table: while a custom list is set, a
// binding answers only to the keys the list gives it. src/ui/keybinds.ts builds the list; the dispatcher and the shortcuts dialog read it.

import { useSyncExternalStore } from "react";
import type { Binding, ShortcutId } from "./bindings";

/** One key spec of a binding and the handler index it fires with (Up/Down pairs: 0 = up, 1 = down). */
export interface BoundKey {
  spec: string;
  index: number;
}

let overrides: ReadonlyMap<ShortcutId, readonly BoundKey[]> | null = null;
let version = 0;
const listeners = new Set<() => void>();

/** `null` = the table's own keys. */
export function setKeyOverrides(next: ReadonlyMap<ShortcutId, readonly BoundKey[]> | null): void {
  overrides = next;
  version += 1;
  for (const listener of listeners) listener();
}

/** The keys in force for a binding. */
export function keysFor(binding: Pick<Binding, "id" | "keys">): readonly BoundKey[] {
  if (!overrides) return binding.keys.map((spec, index) => ({ spec, index }));
  return overrides.get(binding.id as ShortcutId) ?? [];
}

/** Re-renders when the user's keybinds change. */
export function useKeyOverridesVersion(): number {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
}
