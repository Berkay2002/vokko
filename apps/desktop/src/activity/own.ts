import type { Activity } from "../api/types";

// The activities of the signed-in user, kept apart from the store that detects them so `shell/actions.ts` (which sends every
// presence update) can read them without importing the detection code that itself sends presence updates.

let current: Activity[] = [];

export function getOwnActivities(): Activity[] {
  return current;
}

export function setOwnActivities(list: Activity[]): void {
  current = list;
}
