import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, GuildOnboarding } from "../api/types";

const request = vi.hoisted(() => vi.fn());
vi.mock("./shell", async importOriginal => ({ ...(await importOriginal<typeof import("./shell")>()), request }));

import { useOnboardingConfigs } from "./onboardingConfig";
import { RULES_NOT_ACCEPTED, noteRulesRefused } from "./rulesGate";
import { appStore } from "./shell";

const config = (rules_pending: boolean) => ({ guild_id: "1", enabled: true, prompts: [], rules: null, default_channel_ids: [], rules_pending }) as unknown as GuildOnboarding;

describe("noteRulesRefused", () => {
  beforeEach(() => {
    request.mockReset();
    useOnboardingConfigs.setState({}, true);
    appStore.setState({ channels: { "9": { id: "9", guild_id: "1", type: 0, name: "general" } as Channel } });
  });

  it("asks the server again after a 150010, so the composer shows the rules bar", async () => {
    expect(RULES_NOT_ACCEPTED).toBe(150010);
    request.mockResolvedValue(config(true));
    noteRulesRefused("9");
    await vi.waitFor(() => expect(useOnboardingConfigs.getState()["1"]?.rules_pending).toBe(true));
    expect(request).toHaveBeenCalledWith("GET", "/guilds/1/onboarding");
  });

  it("ignores channels without a guild (DMs)", () => {
    appStore.setState({ channels: { "9": { id: "9", type: 1 } as Channel } });
    noteRulesRefused("9");
    expect(request).not.toHaveBeenCalled();
  });
});
