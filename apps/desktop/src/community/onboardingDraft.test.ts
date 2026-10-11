import { describe, expect, it } from "vitest";
import { OnboardingMode, OnboardingPromptType, type GuildOnboarding } from "../api/types";
import { draftProblems, draftsEqual, emptyPrompt, fromConfig, ruleLines, toRequest } from "./onboardingDraft";

const config: GuildOnboarding = {
  guild_id: "1",
  enabled: true,
  mode: OnboardingMode.Advanced,
  default_channel_ids: ["10"],
  rules: { description: "Be nice", items: ["One", "Two"] },
  prompts: [
    {
      id: "20",
      type: OnboardingPromptType.Dropdown,
      title: "What do you play?",
      single_select: true,
      required: true,
      in_onboarding: true,
      options: [{ id: "30", title: "Games", description: null, emoji: { id: null, name: "🎮" }, channel_ids: ["10"], role_ids: ["40"] }],
    },
  ],
};

describe("onboarding draft", () => {
  it("round trips a configuration through the draft", () => {
    const request = toRequest(fromConfig(config));
    expect(request).toEqual({
      enabled: true,
      mode: OnboardingMode.Advanced,
      default_channel_ids: ["10"],
      rules: { description: "Be nice", items: ["One", "Two"] },
      prompts: [
        {
          id: "20",
          type: OnboardingPromptType.Dropdown,
          title: "What do you play?",
          single_select: true,
          required: true,
          in_onboarding: true,
          options: [{ id: "30", title: "Games", description: null, emoji: { id: null, name: "🎮" }, channel_ids: ["10"], role_ids: ["40"] }],
        },
      ],
    });
    expect(draftsEqual(fromConfig(config), fromConfig(config))).toBe(true);
  });

  it("drops empty rules and new rows carry no ids", () => {
    const draft = fromConfig({ ...config, rules: null });
    draft.prompts.push(emptyPrompt());
    const request = toRequest(draft);
    expect(request.rules).toBeNull();
    expect(request.prompts?.[1]).not.toHaveProperty("id");
    expect(ruleLines("  a \n\n b\n")).toEqual(["a", "b"]);
  });

  it("lists what the server would refuse", () => {
    expect(draftProblems(fromConfig(config))).toEqual([]);
    const draft = fromConfig(config);
    draft.prompts.push(emptyPrompt());
    expect(draftProblems(draft)).toEqual(["Question 2 needs a title.", "Question 2, answer 1 needs a title."]);
    draft.prompts[1]!.title = "x".repeat(101);
    draft.prompts[1]!.options = [];
    expect(draftProblems(draft).join(" ")).toContain("needs at least one answer");
    draft.rulesText = Array.from({ length: 17 }, (_, i) => `rule ${i}`).join("\n");
    expect(draftProblems(draft).join(" ")).toContain("At most 16 rules");
  });

  it("notices edits", () => {
    const draft = fromConfig(config);
    const edited = fromConfig(config);
    edited.prompts[0]!.options[0]!.title = "Gaming";
    expect(draftsEqual(draft, edited)).toBe(false);
  });
});
