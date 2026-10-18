// The rules gate (docs/api.md "Rules gate"): while the viewer has not accepted a guild's rules the server refuses their messages and
// reactions, so the composer shows a bar that reopens the rules instead. The server decides (`rules_pending` on GET /onboarding):
// members who joined before the rules existed are not held even though onboarding started for them.

import { useEffect } from "react";
import { MemberFlags, type Snowflake } from "../api/types";
import { loadOnboardingConfig, useOnboardingConfigs } from "./onboardingConfig";
import { needsOnboarding } from "./onboardingLogic";
import { appStore, useStore } from "./shell";

export const RULES_NOT_ACCEPTED = 150010;

/** The member flags the cached configuration of a guild was loaded under: it is loaded again only when they change (or after a refusal). */
const loadedUnder = new Map<Snowflake, number | undefined>();

const loadOnce = (guildId: Snowflake, flags: number | undefined): void => {
  if (loadedUnder.has(guildId) && loadedUnder.get(guildId) === flags && useOnboardingConfigs.getState()[guildId]) return;
  loadedUnder.set(guildId, flags);
  void loadOnboardingConfig(guildId).catch(() => loadedUnder.delete(guildId));
};

/** True while the viewer must accept the rules of `guildId` before talking there. */
export function useRulesPending(guildId: Snowflake | null | undefined): boolean {
  const flags = useStore(s => (guildId && s.me ? s.members[guildId]?.[s.me.id]?.flags : undefined));
  const started = needsOnboarding({ flags });
  const pending = useOnboardingConfigs(s => (guildId ? s[guildId]?.rules_pending : false));
  useEffect(() => {
    if (guildId && started) loadOnce(guildId, flags);
  }, [guildId, started, flags]);
  // The flags can be missing from the member list while the server still holds the member, so a refusal (below) shows the bar too.
  // A finished onboarding always lifts it, whatever the cached copy says.
  return !!pending && !((flags ?? 0) & MemberFlags.CompletedOnboarding);
}

/** A send or reaction came back 150010: ask the server again, so the composer shows the rules bar even if our member flags are missing. */
export function noteRulesRefused(channelId: Snowflake): void {
  const guildId = appStore.getState().channels[channelId]?.guild_id;
  if (!guildId) return;
  loadedUnder.delete(guildId);
  void loadOnboardingConfig(guildId).catch(() => undefined);
}
