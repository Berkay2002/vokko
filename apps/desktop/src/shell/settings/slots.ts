import type { ComponentType } from "react";
import type { User } from "../../api/types";

/**
 * Mount points that other parts of the app fill in for the User Settings pages, so those pages need no import of
 * feature code. Register once at startup (e.g. from src/account/index.ts) with `registerSettingsSlots`.
 */
export const settingsSlots: {
  /** Rendered at the top of the "Password & Security" block of My Account, above the built-in rows. */
  accountSecurity?: ComponentType;
  /**
   * Replaces the built-in Display Name and Username rows of the "Account Info" block (render `SettingsRow`s from
   * `shell/settings/SettingsModal`; add an Email row there too). Unregistered, the built-in rows stay.
   */
  accountIdentity?: ComponentType<{ me: User }>;
  /** A "Sign-in Methods" block after "Password & Security" (linked GitHub / Google / OIDC providers). Hidden while unregistered. */
  signInMethods?: ComponentType;
} = {};

export function registerSettingsSlots(slots: typeof settingsSlots): void {
  Object.assign(settingsSlots, slots);
}
