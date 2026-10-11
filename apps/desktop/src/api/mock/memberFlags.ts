// GuildMember.flags of the mock (kept apart from the member records so mock/db.ts stays as it is).

import { MemberFlags } from "../types";

const flags = new Map<string, number>();
const key = (guildId: string, userId: string) => `${guildId}:${userId}`;

export const getMemberFlags = (guildId: string, userId: string): number => flags.get(key(guildId, userId)) ?? 0;

export function addMemberFlags(guildId: string, userId: string, bits: number): number {
  const next = getMemberFlags(guildId, userId) | bits;
  flags.set(key(guildId, userId), next);
  return next;
}

/** `{ flags }` when any bit is set, like the server (the field is omitted while 0). */
export const flagsField = (guildId: string, userId: string): { flags?: number } => {
  const value = getMemberFlags(guildId, userId);
  return value ? { flags: value } : {};
};

/** guild → user → roles onboarding itself added (only those are taken back when an answer is dropped). */
export const addedByOnboarding = new Map<string, Map<string, Set<string>>>();

/** A moderator took these roles away or handed them out: they are theirs from now on, onboarding must not take them back later. */
export function forgetOnboardingRoles(guildId: string, userId: string, roles: string[]): void {
  const mine = addedByOnboarding.get(guildId)?.get(userId);
  for (const role of roles) mine?.delete(role);
}

export { MemberFlags };
