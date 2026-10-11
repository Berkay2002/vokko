// The server-settings editor for onboarding works on a draft: plain strings and key-ed rows that map to / from the API shapes.
import { OnboardingMode, OnboardingPromptType, type EditOnboardingRequest, type GuildOnboarding, type Snowflake } from "../api/types";

export interface DraftOption {
  key: string;
  id?: Snowflake;
  title: string;
  description: string;
  emoji: string;
  channel_ids: Snowflake[];
  role_ids: Snowflake[];
}

export interface DraftPrompt {
  key: string;
  id?: Snowflake;
  type: OnboardingPromptType;
  title: string;
  single_select: boolean;
  required: boolean;
  in_onboarding: boolean;
  options: DraftOption[];
}

export interface Draft {
  enabled: boolean;
  mode: OnboardingMode;
  default_channel_ids: Snowflake[];
  rulesDescription: string;
  /** One rule per line. */
  rulesText: string;
  prompts: DraftPrompt[];
}

export const LIMITS = { prompts: 15, options: 50, rules: 16, promptTitle: 100, optionTitle: 50, optionDescription: 100, rule: 300, rulesDescription: 300 } as const;

let counter = 0;
export const newKey = (): string => `k${(counter += 1)}`;

export const emptyOption = (): DraftOption => ({ key: newKey(), title: "", description: "", emoji: "", channel_ids: [], role_ids: [] });
export const emptyPrompt = (): DraftPrompt => ({
  key: newKey(),
  type: OnboardingPromptType.MultipleChoice,
  title: "",
  single_select: false,
  required: false,
  in_onboarding: true,
  options: [emptyOption()],
});

export function fromConfig(config: GuildOnboarding): Draft {
  return {
    enabled: config.enabled,
    mode: config.mode,
    default_channel_ids: [...config.default_channel_ids],
    rulesDescription: config.rules?.description ?? "",
    rulesText: config.rules?.items.join("\n") ?? "",
    prompts: config.prompts.map(prompt => ({
      key: newKey(),
      id: prompt.id,
      type: prompt.type,
      title: prompt.title,
      single_select: prompt.single_select,
      required: prompt.required,
      in_onboarding: prompt.in_onboarding,
      options: prompt.options.map(option => ({
        key: newKey(),
        id: option.id,
        title: option.title,
        description: option.description ?? "",
        emoji: option.emoji?.name ?? "",
        channel_ids: [...option.channel_ids],
        role_ids: [...option.role_ids],
      })),
    })),
  };
}

export const ruleLines = (text: string): string[] =>
  text
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

export function toRequest(draft: Draft): EditOnboardingRequest {
  const rules = ruleLines(draft.rulesText);
  return {
    enabled: draft.enabled,
    mode: draft.mode,
    default_channel_ids: draft.default_channel_ids,
    rules: rules.length > 0 ? { description: draft.rulesDescription.trim() || null, items: rules } : null,
    prompts: draft.prompts.map(prompt => ({
      ...(prompt.id ? { id: prompt.id } : {}),
      type: prompt.type,
      title: prompt.title.trim(),
      single_select: prompt.single_select,
      required: prompt.required,
      in_onboarding: prompt.in_onboarding,
      options: prompt.options.map(option => ({
        ...(option.id ? { id: option.id } : {}),
        title: option.title.trim(),
        description: option.description.trim() || null,
        emoji: option.emoji.trim() ? { id: null, name: option.emoji.trim() } : null,
        channel_ids: option.channel_ids,
        role_ids: option.role_ids,
      })),
    })),
  };
}

/** Problems the server would reject, as readable sentences (empty = fine to save). */
export function draftProblems(draft: Draft): string[] {
  const problems: string[] = [];
  if (draft.prompts.length > LIMITS.prompts) problems.push(`At most ${LIMITS.prompts} questions.`);
  draft.prompts.forEach((prompt, i) => {
    const label = `Question ${i + 1}`;
    if (!prompt.title.trim()) problems.push(`${label} needs a title.`);
    else if (prompt.title.trim().length > LIMITS.promptTitle) problems.push(`${label}: the title is too long (${LIMITS.promptTitle} characters at most).`);
    if (prompt.options.length === 0) problems.push(`${label} needs at least one answer.`);
    if (prompt.options.length > LIMITS.options) problems.push(`${label}: at most ${LIMITS.options} answers.`);
    prompt.options.forEach((option, j) => {
      if (!option.title.trim()) problems.push(`${label}, answer ${j + 1} needs a title.`);
      else if (option.title.trim().length > LIMITS.optionTitle) problems.push(`${label}, answer ${j + 1}: the title is too long (${LIMITS.optionTitle} characters at most).`);
      if (option.description.trim().length > LIMITS.optionDescription) problems.push(`${label}, answer ${j + 1}: the description is too long (${LIMITS.optionDescription} characters at most).`);
    });
  });
  const rules = ruleLines(draft.rulesText);
  if (rules.length > LIMITS.rules) problems.push(`At most ${LIMITS.rules} rules.`);
  if (rules.some(rule => rule.length > LIMITS.rule)) problems.push(`A rule can have ${LIMITS.rule} characters at most.`);
  if (draft.rulesDescription.trim().length > LIMITS.rulesDescription) problems.push(`The rules introduction can have ${LIMITS.rulesDescription} characters at most.`);
  return problems;
}

export const draftsEqual = (a: Draft, b: Draft): boolean => JSON.stringify(toRequest(a)) === JSON.stringify(toRequest(b));
