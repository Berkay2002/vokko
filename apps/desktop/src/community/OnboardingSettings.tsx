import { useEffect, useMemo, useState } from "react";
import { Hash, Plus, Trash2, Volume2 } from "lucide-react";
import { ChannelType, OnboardingMode, OnboardingPromptType, type GuildOnboarding, type Snowflake } from "../api/types";
import { errorText } from "./errors";
import { setOnboardingConfig } from "./onboardingConfig";
import { LIMITS, draftProblems, draftsEqual, emptyOption, emptyPrompt, fromConfig, ruleLines, toRequest, type Draft, type DraftOption, type DraftPrompt } from "./onboardingDraft";
import { Category, Page, Perm, SaveBar, SwitchRow, Toggle, request, usePermissions, useStore } from "./shell";

function Chips<T extends string>({ label, items, selected, onToggle }: { label: string; items: { id: T; name: string; icon?: "text" | "voice" | "role"; color?: string }[]; selected: readonly T[]; onToggle(id: T): void }) {
  if (items.length === 0) return <p className="cm-muted">None yet.</p>;
  return (
    <div className="cm-chips" role="group" aria-label={label}>
      {items.map(item => (
        <button key={item.id} type="button" role="checkbox" aria-checked={selected.includes(item.id)} className={`cm-chip${selected.includes(item.id) ? " on" : ""}`} onClick={() => onToggle(item.id)}>
          {item.icon === "text" && <Hash size={14} aria-hidden="true" />}
          {item.icon === "voice" && <Volume2 size={14} aria-hidden="true" />}
          {item.icon === "role" && <span className="cm-role-dot" style={{ background: item.color ?? "var(--text-muted)" }} aria-hidden="true" />}
          {item.name}
        </button>
      ))}
    </div>
  );
}

const toggled = <T,>(list: readonly T[], id: T): T[] => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]);

interface Choices {
  channels: { id: Snowflake; name: string; icon: "text" | "voice" }[];
  roles: { id: Snowflake; name: string; icon: "role"; color: string }[];
}

function OptionEditor({ option, choices, index, onChange, onRemove, canRemove }: { option: DraftOption; choices: Choices; index: number; onChange(next: DraftOption): void; onRemove(): void; canRemove: boolean }) {
  return (
    <fieldset className="cm-option-editor">
      <legend className="sr-only">Answer {index + 1}</legend>
      <div className="cm-row cm-option-row">
        <input className="input cm-emoji-input" aria-label={`Answer ${index + 1} emoji`} placeholder="🙂" maxLength={8} value={option.emoji} onChange={e => onChange({ ...option, emoji: e.target.value })} />
        <input className="input" aria-label={`Answer ${index + 1} title`} placeholder="Answer" maxLength={LIMITS.optionTitle} value={option.title} onChange={e => onChange({ ...option, title: e.target.value })} />
        <button type="button" className="icon-button" aria-label={`Remove answer ${index + 1}`} disabled={!canRemove} onClick={onRemove}>
          <Trash2 size={18} />
        </button>
      </div>
      <input className="input" aria-label={`Answer ${index + 1} description`} placeholder="Description (optional)" maxLength={LIMITS.optionDescription} value={option.description} onChange={e => onChange({ ...option, description: e.target.value })} />
      <div className="cm-chip-group">
        <span className="field-label">Gives these roles</span>
        <Chips label={`Roles for answer ${index + 1}`} items={choices.roles} selected={option.role_ids} onToggle={id => onChange({ ...option, role_ids: toggled(option.role_ids, id) })} />
      </div>
      <div className="cm-chip-group">
        <span className="field-label">Points to these channels</span>
        <Chips label={`Channels for answer ${index + 1}`} items={choices.channels} selected={option.channel_ids} onToggle={id => onChange({ ...option, channel_ids: toggled(option.channel_ids, id) })} />
      </div>
    </fieldset>
  );
}

function PromptEditor({ prompt, index, choices, onChange, onRemove }: { prompt: DraftPrompt; index: number; choices: Choices; onChange(next: DraftPrompt): void; onRemove(): void }) {
  return (
    <section className="cm-prompt-editor" aria-label={`Question ${index + 1}`}>
      <div className="cm-row cm-option-row">
        <input className="input" aria-label={`Question ${index + 1} title`} placeholder="What would you like to ask?" maxLength={LIMITS.promptTitle} value={prompt.title} onChange={e => onChange({ ...prompt, title: e.target.value })} />
        <select
          className="input cm-type-select"
          aria-label={`Question ${index + 1} style`}
          value={prompt.type}
          onChange={e => onChange({ ...prompt, type: Number(e.target.value) as OnboardingPromptType })}
        >
          <option value={OnboardingPromptType.MultipleChoice}>Multiple choice</option>
          <option value={OnboardingPromptType.Dropdown}>Dropdown</option>
        </select>
        <button type="button" className="icon-button" aria-label={`Remove question ${index + 1}`} onClick={onRemove}>
          <Trash2 size={18} />
        </button>
      </div>
      <div className="cm-toggles">
        <label className="cm-toggle-line">
          <Toggle label={`Question ${index + 1}: one answer only`} checked={prompt.single_select} onChange={single_select => onChange({ ...prompt, single_select })} />
          One answer only
        </label>
        <label className="cm-toggle-line">
          <Toggle label={`Question ${index + 1}: required`} checked={prompt.required} onChange={required => onChange({ ...prompt, required })} />
          Required
        </label>
        <label className="cm-toggle-line">
          <Toggle label={`Question ${index + 1}: ask while joining`} checked={prompt.in_onboarding} onChange={in_onboarding => onChange({ ...prompt, in_onboarding })} />
          Ask while joining
        </label>
      </div>
      {prompt.options.map((option, j) => (
        <OptionEditor
          key={option.key}
          option={option}
          index={j}
          choices={choices}
          canRemove={prompt.options.length > 1}
          onChange={next => onChange({ ...prompt, options: prompt.options.map(o => (o.key === option.key ? next : o)) })}
          onRemove={() => onChange({ ...prompt, options: prompt.options.filter(o => o.key !== option.key) })}
        />
      ))}
      <button type="button" className="btn btn-secondary btn-sm" disabled={prompt.options.length >= LIMITS.options} onClick={() => onChange({ ...prompt, options: [...prompt.options, emptyOption()] })}>
        <Plus size={16} aria-hidden="true" />
        Add answer
      </button>
    </section>
  );
}

/** Server Settings > Onboarding: questions that hand out roles and channels, default channels and a rules screen for new members. */
export function OnboardingSettings({ guildId }: { guildId: Snowflake }) {
  const [saved, setSaved] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const [loadError, setLoadError] = useState<string | null>(null);
  const { can } = usePermissions(guildId);
  const channels = useStore(s => s.channels);
  const guild = useStore(s => s.guilds[guildId]);

  useEffect(() => {
    let live = true;
    request<GuildOnboarding>("GET", `/guilds/${guildId}/onboarding`)
      .then(config => {
        if (!live) return;
        const loaded = fromConfig(config);
        setSaved(loaded);
        setDraft(loaded);
      })
      .catch(e => live && setLoadError(errorText(e)));
    return () => {
      live = false;
    };
  }, [guildId]);

  const choices = useMemo<Choices>(
    () => ({
      channels: Object.values(channels)
        .filter(c => c.guild_id === guildId && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice))
        .sort((a, b) => a.position - b.position)
        .map(c => ({ id: c.id, name: c.name ?? "channel", icon: c.type === ChannelType.GuildVoice ? ("voice" as const) : ("text" as const) })),
      roles: (guild?.roles ?? [])
        .filter(r => r.id !== guildId)
        .sort((a, b) => b.position - a.position)
        .map(r => ({ id: r.id, name: r.name, icon: "role" as const, color: r.color ? `#${r.color.toString(16).padStart(6, "0")}` : "var(--text-muted)" })),
    }),
    [channels, guild, guildId],
  );

  if (loadError) return <Page title="Onboarding"><p className="field-error" role="alert">{loadError}</p></Page>;
  if (!draft || !saved) return <Page title="Onboarding"><p className="cm-muted">Loading…</p></Page>;

  const allowed = can(Perm.MANAGE_GUILD) && can(Perm.MANAGE_ROLES);
  const problems = draftProblems(draft);
  const dirty = !draftsEqual(draft, saved);
  const patch = (change: Partial<Draft>) => {
    setDraft({ ...draft, ...change });
    setState(s => ({ ...s, done: false }));
  };
  const setPrompt = (key: string, next: DraftPrompt) => patch({ prompts: draft.prompts.map(p => (p.key === key ? next : p)) });

  const save = async () => {
    setState({ busy: true, error: null, done: false });
    try {
      const config = await request<GuildOnboarding>("PUT", `/guilds/${guildId}/onboarding`, toRequest(draft));
      setOnboardingConfig(config);
      const loaded = fromConfig(config);
      setSaved(loaded);
      setDraft(loaded);
      setState({ busy: false, error: null, done: true });
    } catch (e) {
      setState({ busy: false, error: errorText(e), done: false });
    }
  };

  return (
    <Page title="Onboarding">
      {!allowed && <p className="cm-muted">Changing onboarding needs both the Manage Server and the Manage Roles permission, because answers hand out roles.</p>}
      <fieldset className="cm-fieldset" disabled={!allowed}>
        <SwitchRow label="Enable onboarding" note="New members answer your questions and accept the rules before they land in your channels. People who are already here are not asked." checked={draft.enabled} onChange={enabled => patch({ enabled })} />
        <Category title="Default channels">
          <p className="cm-muted">Where new members land first.</p>
          <Chips label="Default channels" items={choices.channels} selected={draft.default_channel_ids} onToggle={id => patch({ default_channel_ids: toggled(draft.default_channel_ids, id) })} />
        </Category>
        <Category title="Rules">
          <label className="field-label" htmlFor="cm-rules-description">
            Introduction
          </label>
          <input id="cm-rules-description" className="input" maxLength={LIMITS.rulesDescription} placeholder="A few ground rules before you join in." value={draft.rulesDescription} onChange={e => patch({ rulesDescription: e.target.value })} />
          <label className="field-label cm-gap-top" htmlFor="cm-rules-text">
            Rules (one per line, {ruleLines(draft.rulesText).length} of {LIMITS.rules})
          </label>
          <textarea id="cm-rules-text" className="input cm-textarea" rows={5} placeholder={"Be kind to everyone.\nNo spam."} value={draft.rulesText} onChange={e => patch({ rulesText: e.target.value })} />
          <p className="cm-muted">Leave empty to skip the rules screen.</p>
        </Category>
        <Category title="Questions">
          {draft.prompts.map((prompt, i) => (
            <PromptEditor key={prompt.key} prompt={prompt} index={i} choices={choices} onChange={next => setPrompt(prompt.key, next)} onRemove={() => patch({ prompts: draft.prompts.filter(p => p.key !== prompt.key) })} />
          ))}
          <button type="button" className="btn btn-secondary btn-sm" disabled={draft.prompts.length >= LIMITS.prompts} onClick={() => patch({ prompts: [...draft.prompts, emptyPrompt()] })}>
            <Plus size={16} aria-hidden="true" />
            Add question
          </button>
        </Category>
        <label className="cm-toggle-line cm-gap-top">
          <Toggle label="Also show the channels from answers" checked={draft.mode === OnboardingMode.Advanced} onChange={on => patch({ mode: on ? OnboardingMode.Advanced : OnboardingMode.Default })} />
          Take the channels from members&apos; answers into account
        </label>
      </fieldset>
      {problems.length > 0 && (
        <ul className="field-error cm-problems" role="alert">
          {problems.map(problem => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {state.error && (
        <p className="field-error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && !dirty && (
        <div className="cm-save-row">
          <span className="cm-saved" role="status">Saved</span>
        </div>
      )}
      <SaveBar visible={allowed && dirty} busy={state.busy} error={null} saveDisabled={problems.length > 0} onReset={() => setDraft(saved)} onSave={() => void save()} />
    </Page>
  );
}
