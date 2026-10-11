import type { ComponentType } from "react";

/**
 * Mount points that other parts of the app fill in for the User Settings pages, so those pages need no import of
 * feature code. Register once at startup (e.g. from src/account/index.ts) with `registerSettingsSlots`.
 */
export const settingsSlots: {
  /** Rendered at the top of the "Password & Security" block of My Account, above the built-in rows. */
  accountSecurity?: ComponentType;
} = {};

export function registerSettingsSlots(slots: typeof settingsSlots): void {
  Object.assign(settingsSlots, slots);
}
