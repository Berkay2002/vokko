import { useEffect, useSyncExternalStore } from 'react';
import { announce, getPrefs } from '../ui';

// A tiny toast for the chat area ("Forward is coming soon"). There is no toast primitive in src/ui yet; this one lives at the bottom of
// the message list, above the composer, and removes itself after a few seconds. Screen readers get the text from the shell announcer
// (ui/announce.tsx), so the visual toast is aria-hidden and a chat toast is read exactly once, on any page.

interface Toast { id: number; text: string }

let toasts: Toast[] = [];
let counter = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

export function chatToast(text: string, ms = 3500): void {
  // Settings > Accessibility > Minimum notification duration: a toast stays at least that long.
  const shownFor = Math.max(ms, getPrefs().minNotificationDuration * 1000);
  announce(text);
  const id = (counter += 1);
  toasts = [...toasts.filter(t => t.text !== text), { id, text }].slice(-3);
  emit();
  setTimeout(() => { toasts = toasts.filter(t => t.id !== id); emit(); }, shownFor);
}

/** Feature that has no server contract yet: tell the user instead of doing nothing. */
export const comingSoon = (feature: string): void => chatToast(`${feature} is coming soon.`);

function useToasts(): Toast[] {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => toasts);
}

export function ChatToasts() {
  const list = useToasts();
  useEffect(() => () => { toasts = []; }, []);
  if (list.length === 0) return null;
  return <div className="chat-toasts" aria-hidden="true">
    {list.map(t => <div key={t.id} className="chat-toast">{t.text}</div>)}
  </div>;
}
