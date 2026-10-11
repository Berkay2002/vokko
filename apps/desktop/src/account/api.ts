// REST calls and state of My Account (docs/api.md "Accounts").

import { create } from "zustand";
import { request } from "../api/rest";
import { appStore } from "../api/store";
import type { AccountInfo, EditAccountRequest, EditAccountResponse } from "../api/types";

interface AccountState {
  info: AccountInfo | null;
  error: string | null;
}

/** The signed-in user's private account data; loaded when My Account opens. */
export const accountStore = create<AccountState>(() => ({ info: null, error: null }));

// another sign-in (or a sign-out) in the same page must never show the previous user's private data
appStore.subscribe((state, previous) => {
  if (state.token !== previous.token) accountStore.setState({ info: null, error: null });
});

// only the latest load for the current session may write; an older or other-session answer is dropped
let loads = 0;

export async function loadAccount(): Promise<void> {
  const load = ++loads;
  const token = appStore.getState().token;
  const current = () => load === loads && appStore.getState().token === token;
  try {
    const info = await request<AccountInfo>("GET", "/users/@me/account");
    if (current()) accountStore.setState({ info, error: null });
  } catch (error) {
    if (current()) accountStore.setState({ info: null, error: error instanceof Error ? error.message : "Could not load your account." });
  }
}

export async function editAccount(patch: EditAccountRequest): Promise<EditAccountResponse> {
  const token = appStore.getState().token;
  const result = await request<EditAccountResponse>("PATCH", "/users/@me/account", patch);
  if (appStore.getState().token !== token) return result;
  loads++;
  accountStore.setState({ info: result.account });
  appStore.getState().setMe(result.user);
  appStore.getState().cacheUsers([result.user]);
  return result;
}

export function resendVerification(): Promise<void> {
  return request<void>("POST", "/auth/verify/resend");
}

export function disableAccount(password?: string, code?: string): Promise<void> {
  return request<void>("POST", "/users/@me/disable", { password, code });
}

export function deleteAccount(password?: string, code?: string): Promise<void> {
  return request<void>("POST", "/users/@me/delete", { password, code });
}

/** `ab****@example.com`, like Discord's hidden email row. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${"*".repeat(Math.max(4, local.length))}@${domain}`;
}
