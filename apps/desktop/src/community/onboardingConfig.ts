// The onboarding configuration as the viewer sees it (GET /guilds/{id}/onboarding), one copy per guild. The "Channels & Roles" row,
// the rules gate and the settings page share it, so a save in Server Settings shows up in the sidebar without a reload.

import { create } from "zustand";
import type { GuildOnboarding, Snowflake } from "../api/types";
import { request } from "./shell";

export const useOnboardingConfigs = create<Record<Snowflake, GuildOnboarding>>()(() => ({}));

export const setOnboardingConfig = (config: GuildOnboarding): void => useOnboardingConfigs.setState({ [config.guild_id]: config });

/** Fetches the configuration and stores it. Rejects with the API error. */
export async function loadOnboardingConfig(guildId: Snowflake): Promise<GuildOnboarding> {
  const config = await request<GuildOnboarding>("GET", `/guilds/${guildId}/onboarding`);
  setOnboardingConfig(config);
  return config;
}

/** Whether the "Channels & Roles" row has anything to show: onboarding is on and at least one question has options. */
export const hasChannelsAndRoles = (config: GuildOnboarding | undefined): boolean => !!config?.enabled && config.prompts.some(prompt => prompt.options.length > 0);
