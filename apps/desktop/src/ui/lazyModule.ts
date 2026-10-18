// Code split out of the startup bundle that nobody waits for: the voice channel page, the DM call stage and the perk art. A component
// reads the module with `use()` and draws a same-size placeholder (or nothing) until it arrives; `preloadLazyModules()` runs at idle after
// the first paint (main.tsx), so in practice the module is there before anyone opens the screen.
import { useEffect, useSyncExternalStore } from "react";

const all: (() => Promise<unknown>)[] = [];

export interface LazyModule<T> {
  /** The module once loaded, else null; re-renders the caller when it arrives and starts the fetch if nothing has yet. */
  use(): T | null;
  preload(): Promise<T>;
}

export function lazyModule<T>(load: () => Promise<T>): LazyModule<T> {
  let value: T | null = null;
  let loading: Promise<T> | null = null;
  const listeners = new Set<() => void>();
  const preload = () =>
    (loading ??= load().then(
      mod => {
        value = mod;
        listeners.forEach(l => l());
        return mod;
      },
      err => {
        loading = null; // a failed fetch (offline, stale chunk after a redeploy) is retried by the next mount
        throw err;
      },
    ));
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };
  const get = () => value;
  all.push(preload);
  return {
    preload,
    use() {
      const mod = useSyncExternalStore(subscribe, get, get);
      useEffect(() => {
        if (!value) preload().catch(() => {});
      }, []);
      return mod;
    },
  };
}

/** Warm every lazy module (only a warm-up: a failure is retried when a component needs the module). */
export function preloadLazyModules(): Promise<void> {
  return Promise.allSettled(all.map(preload => preload())).then(() => {});
}
