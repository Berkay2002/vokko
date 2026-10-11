// Lazy access to the syntax highlighter (highlight.ts: lowlight + 17 highlight.js grammars, ~85 kB). Code blocks render as plain
// text until it has loaded, then re-render coloured; `preloadHighlighter()` fetches it at idle after startup so that is rarely seen.
import { useSyncExternalStore, type ReactNode } from 'react';

type Highlighter = typeof import('./highlight');

let loaded: Highlighter | null = null;
let loading: Promise<Highlighter> | null = null;
const listeners = new Set<() => void>();

export function preloadHighlighter(): Promise<Highlighter> {
  loading ??= import('./highlight').then(mod => {
    loaded = mod;
    listeners.forEach(l => l());
    return mod;
  }, err => {
    loading = null; // a failed fetch (offline, dev server restart) is retried on the next code block
    throw err;
  });
  return loading;
}

/** Highlight now if the grammars are loaded; otherwise start loading and return the code as plain text. */
export function highlightIfLoaded(code: string, lang: string | null): ReactNode {
  if (loaded) return loaded.highlightToReact(code, lang);
  preloadHighlighter().catch(() => {}); // stays plain text; the next code block tries again
  return code;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

/** True once the highlighter has loaded (re-renders the caller when it arrives). */
export function useHighlighterLoaded(): boolean {
  return useSyncExternalStore(subscribe, () => loaded !== null, () => false);
}
