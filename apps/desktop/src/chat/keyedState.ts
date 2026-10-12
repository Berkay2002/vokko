// State that goes back to its initial value whenever a key changes (the draft text, the active autocomplete query), without a
// reset effect. `useEffect(() => setX(initial), [text])` queues an extra render from a passive effect on every keystroke, and React
// counts consecutive passive-effect updates toward "Maximum update depth exceeded" (it fired while typing a long draft).
//
// Values are stored against a token, a fresh object each time the key changes, not against the key itself: a key that comes back
// (type "a", delete it) gets a new token, so a value set under the earlier occurrence never reappears.
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

/** One occurrence of a key. `next` is the token that replaced it, once that was committed. */
export interface KeyToken {
  next?: KeyToken;
}

export interface Keyed<T> {
  token: KeyToken;
  value: T;
}

/** The value for `token`: the stored one if it was set under that token, else `initial`. */
export function readKeyed<T>(state: Keyed<T> | null, token: KeyToken, initial: T): T {
  return state && state.token === token ? state.value : initial;
}

/** The stored state after a set under `token`; an updater function sees the value for `token` (so `initial` after a key change). */
export function writeKeyed<T>(state: Keyed<T> | null, token: KeyToken, initial: T, next: T | ((prev: T) => T)): Keyed<T> {
  const value = typeof next === 'function' ? (next as (prev: T) => T)(readKeyed(state, token, initial)) : next;
  return { token, value };
}

/** A new token whenever `key` changes; the previous one is linked to it on commit. */
export function useKeyToken(key: string | null): KeyToken {
  const token = useMemo<KeyToken>(() => ({}), [key]);
  const prev = useRef<KeyToken | null>(null);
  useLayoutEffect(() => {
    if (prev.current && prev.current !== token) prev.current.next = token;
    prev.current = token;
  }, [token]);
  return token;
}

export type KeyedSetter<T> = (next: T | ((prev: T) => T), token?: KeyToken) => void;

/**
 * State tied to `token` (from useKeyToken). The setter writes under the latest committed token, or under the one it is given (a late
 * async result aimed at a specific draft: it shows only while that draft is current).
 */
export function useKeyedState<T>(token: KeyToken, initial: T): [T, KeyedSetter<T>] {
  const [state, setState] = useState<Keyed<T> | null>(null);
  const latest = useRef({ token, initial });
  useLayoutEffect(() => {
    latest.current = { token, initial };
  });
  const set = useCallback<KeyedSetter<T>>((next, at) => setState(s => writeKeyed(s, at ?? latest.current.token, latest.current.initial, next)), []);
  return [readKeyed(state, token, initial), set];
}

/**
 * Hands `apply` the token that replaced `submitted`: the draft a send leaves behind. A result that settles before that clearing is
 * committed waits one task for it; when it never comes, the result is dropped. Setting under that token means the result shows only
 * until the draft is edited again.
 */
export function afterNextKey(submitted: KeyToken, apply: (token: KeyToken) => void): void {
  if (submitted.next) {
    apply(submitted.next);
    return;
  }
  setTimeout(() => {
    if (submitted.next) apply(submitted.next);
  }, 0);
}
