// The rules gate (docs/api.md "Rules gate"): while the viewer has not accepted a guild's rules the server refuses their messages and
// reactions, so the composer shows a bar that reopens the rules instead. The server decides (`rules_pending` on GET /onboarding):
// members who joined before the rules existed are not held even though onboarding started for them.

import { useEffect } from "react";
import type { Snowflake } from "../api/types";
import { loadOnboardingConfig, useOnboardingConfigs } from "./onboardingConfig";
import { needsOnboarding } from "./onboardingLogic";
import { useStore } from "./shell";

/** True while the viewer must accept the rules of `guildId` before talking there. */
export function useRulesPending(guildId: Snowflake | null | undefined): boolean {
  const flags = useStore(s => (guildId && s.me ? s.members[guildId]?.[s.me.id]?.flags : undefined));
  const started = needsOnboarding({ flags });
  const pending = useOnboardingConfigs(s => (guildId ? s[guildId]?.rules_pending : false));
  useEffect(() => {
    if (guildId && started) void loadOnboardingConfig(guildId).catch(() => undefined);
  }, [guildId, started]);
  return started && !!pending;
}
