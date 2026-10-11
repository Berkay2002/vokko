import { describe, expect, it } from "vitest";
import { MemberFlags, OnboardingMode, OnboardingPromptType, type GuildOnboarding, type OnboardingPrompt } from "../api/types";
import { answerIds, canContinue, needsOnboarding, onboardingSteps, toggleAnswer } from "./onboardingLogic";

const option = (id: string) => ({ id, title: id, description: null, emoji: null, channel_ids: [], role_ids: [] });
const prompt = (id: string, patch: Partial<OnboardingPrompt> = {}): OnboardingPrompt => ({
  id,
  type: OnboardingPromptType.MultipleChoice,
  title: id,
  options: [option(`${id}a`), option(`${id}b`)],
  single_select: false,
  required: false,
  in_onboarding: true,
  ...patch,
});
const config = (patch: Partial<GuildOnboarding> = {}): GuildOnboarding => ({
  guild_id: "1",
  prompts: [prompt("p1", { required: true }), prompt("p2", { in_onboarding: false }), prompt("p3", { options: [] })],
  default_channel_ids: [],
  enabled: true,
  mode: OnboardingMode.Default,
  rules: { description: null, items: ["Be kind"] },
  ...patch,
});

describe("onboardingSteps", () => {
  it("is intro, the asked questions with options, then the rules", () => {
    expect(onboardingSteps(config()).map(s => (s.kind === "prompt" ? s.prompt.id : s.kind))).toEqual(["intro", "p1", "rules"]);
    expect(onboardingSteps(config({ rules: null, prompts: [] })).map(s => s.kind)).toEqual(["intro"]);
    expect(onboardingSteps(config({ rules: { description: null, items: [] } })).map(s => s.kind)).toEqual(["intro", "prompt"]);
  });
});

describe("needsOnboarding", () => {
  it("is started and not completed", () => {
    expect(needsOnboarding({ flags: MemberFlags.StartedOnboarding })).toBe(true);
    expect(needsOnboarding({ flags: MemberFlags.StartedOnboarding | MemberFlags.CompletedOnboarding })).toBe(false);
    expect(needsOnboarding({})).toBe(false);
    expect(needsOnboarding(undefined)).toBe(false);
  });
});

describe("answers", () => {
  const steps = onboardingSteps(config());
  const [intro, question, rules] = steps as [(typeof steps)[0], (typeof steps)[0], (typeof steps)[0]];

  it("gates required questions and the rules", () => {
    expect(canContinue(intro, new Set(), false)).toBe(true);
    expect(canContinue(question, new Set(), false)).toBe(false);
    expect(canContinue(question, new Set(["p1b"]), false)).toBe(true);
    expect(canContinue(rules, new Set(), false)).toBe(false);
    expect(canContinue(rules, new Set(), true)).toBe(true);
    expect(canContinue({ kind: "prompt", prompt: prompt("x") }, new Set(), false)).toBe(true);
  });

  it("toggles multi-select and swaps single-select answers", () => {
    const multi = prompt("m");
    expect([...toggleAnswer(multi, new Set(), "ma")]).toEqual(["ma"]);
    expect([...toggleAnswer(multi, new Set(["ma"]), "mb")].sort()).toEqual(["ma", "mb"]);
    expect([...toggleAnswer(multi, new Set(["ma"]), "ma")]).toEqual([]);
    const single = prompt("s", { single_select: true });
    expect([...toggleAnswer(single, new Set(["sa"]), "sb")]).toEqual(["sb"]);
    expect([...toggleAnswer(single, new Set(["sa"]), "sa")]).toEqual([]);
    expect([...toggleAnswer(prompt("r", { single_select: true, required: true }), new Set(["ra"]), "ra")]).toEqual(["ra"]);
  });

  it("only sends answers that still exist, in prompt order", () => {
    expect(answerIds(config(), new Set(["p2b", "p1a", "gone"]))).toEqual(["p1a", "p2b"]);
  });
});
