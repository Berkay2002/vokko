import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { type GuildOnboarding, type OnboardingCompletion, type OnboardingOption, type OnboardingPrompt, type Snowflake } from "../api/types";
import { errorText } from "./errors";
import { answerIds, canContinue, needsOnboarding, onboardingSteps, toggleAnswer, type OnboardingStep } from "./onboardingLogic";
import { GuildIcon, Modal, appStore, go, guildPath, request, useStore } from "./shell";

/** Guilds whose flow the member pushed aside with "Do this later" (until the page reloads). */
const postponed = new Set<Snowflake>();
let postponedVersion = 0;
const listeners = new Set<() => void>();
const bump = () => {
  postponedVersion += 1;
  listeners.forEach(fn => fn());
};

/** Shows the onboarding flow over the app while the viewer is in a guild where it started for them and they have not finished. */
export function OnboardingGate() {
  const guildId = useStore(s => s.route.guildId);
  const flags = useStore(s => (guildId && s.me ? s.members[guildId]?.[s.me.id]?.flags : undefined));
  const [, setTick] = useState(postponedVersion);
  useEffect(() => {
    const listener = () => setTick(postponedVersion);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  if (!guildId || postponed.has(guildId) || !needsOnboarding({ flags })) return null;
  return <OnboardingFlow key={guildId} guildId={guildId} onLater={() => (postponed.add(guildId), bump())} />;
}

function OptionCard({ option, selected, single, onToggle }: { option: OnboardingOption; selected: boolean; single: boolean; onToggle(): void }) {
  return (
    <button type="button" role={single ? "radio" : "checkbox"} aria-checked={selected} className={`cm-option${selected ? " selected" : ""}`} onClick={onToggle}>
      <span className="cm-option-emoji" aria-hidden="true">
        {option.emoji?.name ?? ""}
      </span>
      <span className="cm-option-text">
        <span className="cm-option-title">{option.title}</span>
        {option.description && <span className="cm-option-description">{option.description}</span>}
      </span>
      <span className="cm-option-check" aria-hidden="true">
        {selected && <Check size={16} strokeWidth={3} />}
      </span>
    </button>
  );
}

function PromptStep({ prompt, answers, onToggle }: { prompt: OnboardingPrompt; answers: ReadonlySet<Snowflake>; onToggle(optionId: Snowflake): void }) {
  return (
    <div role={prompt.single_select ? "radiogroup" : "group"} aria-label={prompt.title} className="cm-options">
      <p className="cm-muted">{prompt.single_select ? "Pick one." : "Pick as many as you like."}{prompt.required ? " This one is required." : ""}</p>
      {prompt.options.map(option => (
        <OptionCard key={option.id} option={option} selected={answers.has(option.id)} single={prompt.single_select} onToggle={() => onToggle(option.id)} />
      ))}
    </div>
  );
}

export function OnboardingFlow({ guildId, onLater }: { guildId: Snowflake; onLater(): void }) {
  const guild = useStore(s => s.guilds[guildId]);
  const [config, setConfig] = useState<GuildOnboarding | null>(null);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Set<Snowflake>>(new Set());
  const [rulesAccepted, setRulesAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    request<GuildOnboarding>("GET", `/guilds/${guildId}/onboarding`)
      .then(loaded => live && setConfig(loaded))
      .catch(() => live && onLater());
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId]);

  const steps = useMemo<OnboardingStep[]>(() => (config ? onboardingSteps(config) : []), [config]);
  if (!guild || !config || !config.enabled) return null;
  const step = steps[index] ?? steps[0]!;
  const last = index === steps.length - 1;

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const done = await request<OnboardingCompletion>("PUT", `/guilds/${guildId}/onboarding-responses`, {
        option_ids: answerIds(config, answers),
        ...(config.rules ? { rules_accepted: rulesAccepted } : {}),
      });
      const state = appStore.getState();
      const known = state.members[guildId] ?? {};
      appStore.setState({ members: { ...state.members, [guildId]: { ...known, [done.member.user.id]: { ...known[done.member.user.id], ...done.member } } } });
      const target = done.channel_ids.find(id => appStore.getState().channels[id]?.type === 0) ?? done.channel_ids[0];
      go(target ? guildPath(guildId, target) : guildPath(guildId), { replace: true });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const title = step.kind === "intro" ? `Welcome to ${guild.name}` : step.kind === "rules" ? "Server rules" : step.prompt.title;
  const first = index === 0;
  return (
    <Modal
      open
      onClose={onLater}
      title={title}
      className="modal-medium cm-modal cm-onboarding"
      footer={
        <>
          {first ? (
            <button type="button" className="btn btn-link footer-back" disabled={busy} onClick={onLater}>
              Do this later
            </button>
          ) : (
            <button type="button" className="btn btn-link footer-back" disabled={busy} onClick={() => setIndex(i => i - 1)}>
              Back
            </button>
          )}
          {step.kind === "prompt" && !step.prompt.required && !canContinue(step, answers, rulesAccepted) && !last && (
            <button type="button" className="btn btn-secondary" onClick={() => setIndex(i => i + 1)}>
              Skip
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={busy || !canContinue(step, answers, rulesAccepted)}
            onClick={() => (last ? void finish() : setIndex(i => i + 1))}
          >
            {last ? (first ? "Let's go" : "Finish") : first ? "Get started" : "Continue"}
          </button>
        </>
      }
    >
      <div className="cm-onboarding-body">
        {step.kind === "intro" && (
          <div className="cm-intro">
            <GuildIcon guild={guild} size={80} />
            <p>
              {steps.length > 1
                ? "Answer a couple of quick questions so we can set you up with the right channels and roles."
                : "You're all set to join in."}
            </p>
          </div>
        )}
        {step.kind === "prompt" && <PromptStep prompt={step.prompt} answers={answers} onToggle={id => setAnswers(current => toggleAnswer(step.prompt, current, id))} />}
        {step.kind === "rules" && config.rules && (
          <div className="cm-rules">
            {config.rules.description && <p>{config.rules.description}</p>}
            <ol className="cm-rule-list">
              {config.rules.items.map((rule, i) => (
                <li key={i}>{rule}</li>
              ))}
            </ol>
            <label className="cm-agree">
              <input type="checkbox" checked={rulesAccepted} onChange={e => setRulesAccepted(e.target.checked)} />
              <span>I have read the rules and agree to follow them.</span>
            </label>
          </div>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
