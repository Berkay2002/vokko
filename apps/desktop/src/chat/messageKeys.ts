// Keyboard movement through the message list (Discord parity): one tab stop for the whole list, Up/Down/PageUp/PageDown/Home/End
// move it between messages, and a focused message takes hotkeys for its actions.

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat'>;

/** The row index focus moves to from `index` (of `count` rows, `page` rows per screen), or null when the key is not list navigation. */
export function navIndex(e: KeyLike, index: number, count: number, page: number): number | null {
  // Alt+Up/Down (channels), Shift+PageUp (oldest unread) and the other modified keys belong to the shell's shortcuts.
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || count === 0) return null;
  const step: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, PageUp: -page, PageDown: page, Home: -count, End: count };
  const d = step[e.key];
  return d === undefined ? null : Math.min(count - 1, Math.max(0, index + d));
}

export type MessageHotkey = 'edit' | 'reply' | 'react' | 'pin' | 'delete' | 'copy';

/** E edit, R reply, + react, P pin, Delete/Backspace delete (Shift skips the confirm), Mod+C copy text. */
export function messageHotkey(e: KeyLike): MessageHotkey | null {
  if (e.repeat || e.altKey) return null;
  const mod = e.ctrlKey || e.metaKey;
  if (mod) return !e.shiftKey && e.key.toLowerCase() === 'c' ? 'copy' : null;
  if (e.key === '+') return 'react';
  if (e.key === 'Delete' || e.key === 'Backspace') return 'delete';
  if (e.shiftKey) return null;
  return ({ e: 'edit', r: 'reply', p: 'pin' } as const)[e.key as 'e' | 'r' | 'p'] ?? null;
}
