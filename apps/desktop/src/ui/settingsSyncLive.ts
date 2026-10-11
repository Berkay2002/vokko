// The running app's settings sync: one SettingsSync bound to usePrefs, the REST client and the gateway (imported by main.tsx).

import { gateway } from "../api/gateway";
import { request } from "../api/rest";
import { appStore } from "../api/store";
import type { UserSettings } from "../api/types";
import { getPrefs, usePrefs } from "./prefs";
import { createSettingsSync, type PendingRecord } from "./settingsSync";

const SYNCED_FOR_KEY = "vokko.prefs.syncedFor";
const pendingKey = (accountId: string) => `vokko.prefs.pending.${accountId}`;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage full or blocked: the sync still works for this run */
  }
}

function loadPending(accountId: string): PendingRecord | null {
  const raw = read(pendingKey(accountId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingRecord> | null;
    if (!parsed || typeof parsed !== "object" || !parsed.values || typeof parsed.values !== "object") return null;
    return {
      version: typeof parsed.version === "number" ? parsed.version : null,
      base: parsed.base && typeof parsed.base === "object" ? parsed.base : {},
      values: parsed.values,
    };
  } catch {
    return null;
  }
}

/** The account of the last READY: the store may apply READY after this module's listener runs, so `me` can still be the old one. */
let readyUser: string | null = null;

export const settingsSync = createSettingsSync({
  getPrefs,
  setPrefs: patch => usePrefs.setState(patch),
  subscribe: listener => usePrefs.subscribe(listener),
  fetchSettings: () => request<UserSettings>("GET", "/users/@me/settings"),
  patchSettings: body => request<UserSettings>("PATCH", "/users/@me/settings", body),
  accountId: () => readyUser ?? appStore.getState().me?.id ?? null,
  getSyncedFor: () => read(SYNCED_FOR_KEY),
  setSyncedFor: id => write(SYNCED_FOR_KEY, id),
  loadPending,
  savePending: (id, record) => write(pendingKey(id), record ? JSON.stringify(record) : null),
});

let wired = false;

export function wireSettingsSync(): void {
  if (wired) return;
  wired = true;
  gateway.on("READY", ready => {
    readyUser = ready.user.id;
    settingsSync.start().catch(error => console.warn("[settings] could not load account settings", error));
  });
  gateway.on("USER_SETTINGS_UPDATE", blob => settingsSync.applyRemote(blob));
  // Signed out (or another account): forget the account state; the next READY loads it again.
  let me = appStore.getState().me?.id ?? null;
  appStore.subscribe(state => {
    const next = state.me?.id ?? null;
    if (next === me) return;
    if (next !== readyUser) readyUser = null;
    if (me !== null) settingsSync.stop();
    me = next;
  });
  if (typeof window !== "undefined") window.addEventListener("pagehide", () => void settingsSync.flush());
}

wireSettingsSync();
