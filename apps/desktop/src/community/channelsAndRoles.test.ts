import { beforeEach, describe, expect, it } from "vitest";
import type { GuildOnboarding } from "../api/types";
import { hasChannelsAndRoles, setOnboardingConfig, useOnboardingConfigs } from "./onboardingConfig";

const config = (over: Partial<GuildOnboarding> = {}): GuildOnboarding =>
  ({ guild_id: "1", enabled: true, prompts: [{ id: "2", options: [{ id: "3" }] }], rules: null, default_channel_ids: [], ...over }) as unknown as GuildOnboarding;

describe("hasChannelsAndRoles", () => {
  it("shows the row only when onboarding is on and a question has options", () => {
    expect(hasChannelsAndRoles(config())).toBe(true);
    expect(hasChannelsAndRoles(undefined)).toBe(false);
    expect(hasChannelsAndRoles(config({ enabled: false }))).toBe(false);
    expect(hasChannelsAndRoles(config({ prompts: [] }))).toBe(false);
    expect(hasChannelsAndRoles(config({ prompts: [{ id: "2", options: [] } as never] }))).toBe(false);
  });
});

describe("setOnboardingConfig", () => {
  beforeEach(() => useOnboardingConfigs.setState({}, true));

  it("keeps one copy per guild, so a settings save reaches the sidebar and the composer", () => {
    setOnboardingConfig(config({ rules_pending: true }));
    expect(useOnboardingConfigs.getState()["1"]?.rules_pending).toBe(true);
    setOnboardingConfig(config({ rules_pending: false }));
    expect(useOnboardingConfigs.getState()["1"]?.rules_pending).toBe(false);
  });
});
