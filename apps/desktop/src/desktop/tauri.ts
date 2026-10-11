import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** True inside the Tauri webview. Every desktop adapter is a no-op (or returns its documented fallback) when this is false. */
export function isDesktop(): boolean {
  return isTauri();
}

/** Calls a Rust command; `fallback` is returned outside Tauri and when the call fails (the failure is logged, never thrown). */
export async function call<T>(command: string, args: Record<string, unknown> | undefined, fallback: T): Promise<T> {
  if (!isDesktop()) return fallback;
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    console.warn(`[desktop] ${command} failed`, error);
    return fallback;
  }
}

/** Like `call` but rejects with the Rust error string, for actions the UI must report (toggles that can fail). Outside Tauri it resolves to `fallback`. */
export async function callStrict<T>(command: string, args: Record<string, unknown> | undefined, fallback: T): Promise<T> {
  if (!isDesktop()) return fallback;
  return invoke<T>(command, args);
}

/** Subscribes to a Rust event. Returns an unsubscribe function (a no-op outside Tauri). */
export async function onDesktopEvent<T>(name: string, handler: (payload: T) => void): Promise<() => void> {
  if (!isDesktop()) return () => undefined;
  try {
    return await listen<T>(name, event => handler(event.payload));
  } catch (error) {
    console.warn(`[desktop] cannot listen to ${name}`, error);
    return () => undefined;
  }
}
