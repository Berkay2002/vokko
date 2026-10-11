// Pure rules of the member onboarding flow: which steps there are, when a step may be left, what to send.
import { MemberFlags, type GuildMember, type GuildOnboarding, type OnboardingPrompt, type Snowflake } from "../api/types";

export type OnboardingStep = { kind: "intro" } | { kind: "prompt"; prompt: OnboardingPrompt } | { kind: "rules" };

/** Intro, the questions asked during onboarding (only those with options), then the rules when there are any. */
export function onboardingSteps(config: GuildOnboarding): OnboardingStep[] {
  const steps: OnboardingStep[] = [{ kind: "intro" }];
  for (const prompt of config.prompts) if (prompt.in_onboarding && prompt.options.length > 0) steps.push({ kind: "prompt", prompt });
  if (config.rules && config.rules.items.length > 0) steps.push({ kind: "rules" });
  return steps;
}

/** The member still has to go through onboarding: it started for them and they have not finished. */
export function needsOnboarding(member: Pick<GuildMember, "flags"> | undefined | null): boolean {
  const flags = member?.flags ?? 0;
  return (flags & MemberFlags.StartedOnboarding) !== 0 && (flags & MemberFlags.CompletedOnboarding) === 0;
}

/** A required question needs an answer before moving on; the rules step needs the checkbox. */
export function canContinue(step: OnboardingStep, answers: ReadonlySet<Snowflake>, rulesAccepted: boolean): boolean {
  if (step.kind === "prompt") return !step.prompt.required || step.prompt.options.some(option => answers.has(option.id));
  if (step.kind === "rules") return rulesAccepted;
  return true;
}

/** Selecting an option: single-select questions keep one answer, others toggle. Returns a new set. */
export function toggleAnswer(prompt: OnboardingPrompt, answers: ReadonlySet<Snowflake>, optionId: Snowflake): Set<Snowflake> {
  const next = new Set(answers);
  if (prompt.single_select) {
    for (const option of prompt.options) next.delete(option.id);
    if (!answers.has(optionId)) next.add(optionId);
    else if (prompt.required) next.add(optionId);
    return next;
  }
  if (next.has(optionId)) next.delete(optionId);
  else next.add(optionId);
  return next;
}

/** Only answers to questions that still exist, in prompt order. */
export function answerIds(config: GuildOnboarding, answers: ReadonlySet<Snowflake>): Snowflake[] {
  return config.prompts.flatMap(prompt => prompt.options.filter(option => answers.has(option.id)).map(option => option.id));
}
