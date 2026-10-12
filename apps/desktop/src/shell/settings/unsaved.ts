import { useSyncExternalStore } from "react";

/**
 * Unsaved-changes guard shared by SaveBar and the User, Channel and Server Settings frames. A visible SaveBar registers
 * itself; closing the modal or leaving the page asks `blockedByUnsaved()`, which refuses and shakes the bar instead.
 */
const open = new Set<symbol>();
const listeners = new Set<() => void>();
let shakes = 0;

export function registerUnsaved(): () => void {
  const token = Symbol("unsaved");
  open.add(token);
  return () => void open.delete(token);
}

/** True (and the bars shake) while a page has unsaved changes. */
export function blockedByUnsaved(): boolean {
  if (open.size === 0) return false;
  shakes += 1;
  listeners.forEach(l => l());
  return true;
}

/** Number of refused leave attempts so far; a bar compares it with the value it mounted at to know when to shake. */
export function useUnsavedShakes(): number {
  return useSyncExternalStore(
    cb => (listeners.add(cb), () => void listeners.delete(cb)),
    () => shakes,
  );
}
