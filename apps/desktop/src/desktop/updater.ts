import { create } from "zustand";
import { call, callStrict, isDesktop, onDesktopEvent } from "./tauri";
import { getAppVersion } from "./window";

/**
 * Mirrors `updates::UpdateStatus` in src-tauri. `disabled` means this build has no updater config (or this is the browser);
 * `packageManager` is a Linux .deb install, which its package manager updates.
 */
export type UpdateStatus =
  | { state: "disabled" }
  | { state: "packageManager" }
  | { state: "idle" }
  | { state: "checking" }
  | { state: "upToDate" }
  | { state: "available"; version: string; notes: string | null }
  | { state: "downloading"; version: string; downloaded: number; total: number | null }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

const DISABLED: UpdateStatus = { state: "disabled" };
const UPDATE_EVENT = "desktop-update";
const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Current update state for the "update ready, restart" banner: `useDesktopUpdate(s => s.status.state === "ready")`. */
export const useDesktopUpdate = create<{ status: UpdateStatus }>(() => ({ status: DISABLED }));

const publish = (status: UpdateStatus): void => useDesktopUpdate.setState({ status });

/** Checks now and, unless `download` is false, downloads in the background. Resolves to the resulting status. */
export async function checkForUpdate(download = true): Promise<UpdateStatus> {
  const status = await call<UpdateStatus>("desktop_update_check", { download }, DISABLED);
  publish(status);
  return status;
}

/** Downloads the update found by the last check (only needed after `checkForUpdate(false)`). */
export async function downloadUpdate(): Promise<UpdateStatus> {
  const status = await call<UpdateStatus>("desktop_update_download", undefined, DISABLED);
  publish(status);
  return status;
}

/** Installs the downloaded update and restarts Vokko (the installer takes over on Windows). Rejects if nothing is ready. */
export async function restartToUpdate(): Promise<void> {
  await callStrict<void>("desktop_update_install", undefined, undefined);
}

/** True when release `a` is newer than `b` (`0.1.10` > `0.1.9`; a leading `v` and any `-pre`/`+build` suffix are ignored). */
export function isNewerVersion(a: string, b: string): boolean {
  const parts = (v: string) => v.trim().replace(/^v/, "").split(/[-+]/)[0].split(".").map(n => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/**
 * The server announced its latest desktop release (READY `desktop_version`, DESKTOP_VERSION): checks now, instead of on the 4 h
 * timer, when it is newer than this build. Skipped while a check or download runs or an update waits for its restart.
 */
export async function noticeLatestVersion(latest: string): Promise<void> {
  const { state } = useDesktopUpdate.getState().status;
  if (state !== "idle" && state !== "upToDate" && state !== "error") return;
  const current = await getAppVersion();
  if (current && isNewerVersion(latest, current)) await checkForUpdate();
}

let started = false;

/**
 * Mirrors Rust-side status into `useDesktopUpdate` and, when this build has an updater configured, checks shortly
 * after launch and then every few hours. Does nothing in the browser or in a build without updater config.
 */
export async function initUpdater(options: { checkIntervalMs?: number } = {}): Promise<() => void> {
  if (!isDesktop() || started) return () => undefined;
  started = true;
  const unlisten = await onDesktopEvent<UpdateStatus>(UPDATE_EVENT, publish);
  const initial = await call<UpdateStatus>("desktop_update_status", undefined, DISABLED);
  publish(initial);
  if (initial.state === "disabled" || initial.state === "packageManager") {
    unlisten();
    started = false;
    return () => undefined;
  }
  const interval = options.checkIntervalMs ?? CHECK_INTERVAL_MS;
  const first = setTimeout(() => void checkForUpdate(), FIRST_CHECK_DELAY_MS);
  const timer = setInterval(() => void checkForUpdate(), interval);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    unlisten();
    started = false;
  };
}
