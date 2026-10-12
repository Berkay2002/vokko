import { useEffect, useRef, useSyncExternalStore } from "react";

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

/**
 * Guard for anything that shows unsaved edits: registers while `active` and returns the `data-shake` value ("a"/"b", alternating
 * so the CSS animation restarts) for the element that should shake after each refused leave attempt.
 */
export function useUnsavedShake(active: boolean): "a" | "b" | undefined {
  useEffect(() => (active ? registerUnsaved() : undefined), [active]);
  const shakes = useUnsavedShakes();
  const mountedAt = useRef(shakes);
  // Re-baseline while inactive so a bar that comes back after Reset does not start out shaking from earlier refusals.
  if (!active) {
    mountedAt.current = shakes;
    return undefined;
  }
  const shaken = shakes - mountedAt.current;
  return shaken > 0 ? (shaken % 2 ? "a" : "b") : undefined;
}
