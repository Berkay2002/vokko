import { useSyncExternalStore } from "react";

// The one screen-reader announcer. <Announcer /> is mounted once above the router (App.tsx) and is never unmounted, so its role="status"
// region exists before the first message (screen readers often miss a live region that mounts together with its text). announce() works
// from any module, on any page.

interface Message { id: number; text: string }

let current: Message | null = null;
let counter = 0;
const listeners = new Set<() => void>();
const CLEAR_AFTER_MS = 5000;

/** Say `text` politely. The same text again is announced again: every call renders a fresh node. */
export function announce(text: string): void {
  counter += 1;
  const id = counter;
  current = { id, text };
  listeners.forEach(l => l());
  // Don't leave the last message in the DOM for browse mode to find; a newer call must not be wiped by this timer.
  setTimeout(() => {
    if (current?.id !== id) return;
    current = null;
    listeners.forEach(l => l());
  }, CLEAR_AFTER_MS);
}

/** The current message; a repeat of the same text has a new id (the render key). */
export const currentAnnouncement = (): Readonly<Message> | null => current;

export function Announcer() {
  const message = useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, currentAnnouncement, currentAnnouncement);
  return <div className="sr-only" role="status" aria-live="polite" data-testid="announcer">
    {message && <span key={message.id}>{message.text}</span>}
  </div>;
}
