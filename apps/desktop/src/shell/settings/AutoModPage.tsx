import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AtSign, Hash, ListFilter, ListPlus, Minus, OctagonX, Plus, ShieldOff, Timer, Trash2, Repeat2 } from "lucide-react";
import { gateway } from "../../api/gateway";
import { useStore } from "../../api/store";
import {
  AutoModerationActionType,
  AutoModerationEventType,
  AutoModerationKeywordPresetType,
  AutoModerationTriggerType,
  ChannelType,
  type AutoModerationRule,
  type AutoModerationRuleRequest,
  type Guild,
} from "../../api/types";
import { Category, Field, Page, Select, SwitchRow, Unavailable } from "./controls";
import { createAutomodRule, deleteAutomodRule, listAutomodRules, updateAutomodRule } from "./admin";
import { SaveBar } from "./SaveBar";
import { errorText, roleColor } from "./shared";

const T = AutoModerationTriggerType;
const A = AutoModerationActionType;
const KEYWORD_RULE_LIMIT = 6;

interface Kind {
  type: AutoModerationTriggerType;
  title: string;
  description: string;
  icon: ReactNode;
  actions: AutoModerationActionType[];
}

// Discord's four content rules, in its order; the actions each type allows (docs/api.md "AutoMod").
const KINDS: Kind[] = [
  { type: T.MentionSpam, title: "Block Mention Spam", description: "Block messages with an excessive number of role and user mentions.", icon: <AtSign size={20} />, actions: [A.BlockMessage, A.SendAlertMessage, A.Timeout] },
  {
    type: T.Spam,
    title: "Block Suspected Spam Content",
    description: "Block a member's message when they post the same text for the third time within 30 seconds anywhere in the server.",
    icon: <Repeat2 size={20} />,
    actions: [A.BlockMessage, A.SendAlertMessage],
  },
  { type: T.KeywordPreset, title: "Block Commonly Flagged Words", description: "Flag messages with profanity, slurs or sexual content from Vokko's built-in word lists.", icon: <ListFilter size={20} />, actions: [A.BlockMessage, A.SendAlertMessage] },
  { type: T.Keyword, title: "Block Custom Words", description: "Create your own filter to block specific words from your server.", icon: <ListPlus size={20} />, actions: [A.BlockMessage, A.SendAlertMessage, A.Timeout] },
];

const ACTION_CHIPS: Record<AutoModerationActionType, { label: string; icon: ReactNode }> = {
  [A.BlockMessage]: { label: "block message", icon: <OctagonX size={12} /> },
  [A.SendAlertMessage]: { label: "send alert", icon: <Hash size={12} /> },
  [A.Timeout]: { label: "timeout member", icon: <Timer size={12} /> },
};

const PRESETS: { value: AutoModerationKeywordPresetType; label: string; note: string }[] = [
  { value: AutoModerationKeywordPresetType.Profanity, label: "Profanity", note: "Swearing and crude language" },
  { value: AutoModerationKeywordPresetType.Slurs, label: "Insults and Slurs", note: "Terms that may be considered hate speech" },
  { value: AutoModerationKeywordPresetType.SexualContent, label: "Sexual Content", note: "Terms referring to sexual acts or behaviour" },
];

const TIMEOUTS: { seconds: number; label: string }[] = [
  { seconds: 60, label: "60 seconds" },
  { seconds: 300, label: "5 minutes" },
  { seconds: 600, label: "10 minutes" },
  { seconds: 3600, label: "1 hour" },
  { seconds: 86_400, label: "1 day" },
  { seconds: 604_800, label: "1 week" },
];

const splitList = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(Boolean);

interface Draft {
  name: string;
  enabled: boolean;
  keywords: string;
  allow: string;
  presets: AutoModerationKeywordPresetType[];
  limit: number;
  block: boolean;
  message: string;
  alert: boolean;
  alertChannel: string;
  timeout: boolean;
  timeoutSeconds: number;
  exemptRoles: string[];
  exemptChannels: string[];
}

function draftOf(kind: Kind, rule: AutoModerationRule | null): Draft {
  const action = (type: AutoModerationActionType) => rule?.actions.find(a => a.type === type);
  const meta = rule?.trigger_metadata;
  return {
    name: rule?.name ?? kind.title,
    enabled: rule?.enabled ?? true,
    keywords: meta?.keyword_filter.join(", ") ?? "",
    allow: meta?.allow_list.join(", ") ?? "",
    presets: meta?.presets ?? PRESETS.map(p => p.value),
    limit: meta?.mention_total_limit ?? 20,
    block: rule ? !!action(A.BlockMessage) : true,
    message: action(A.BlockMessage)?.metadata?.custom_message ?? "",
    alert: !!action(A.SendAlertMessage),
    alertChannel: action(A.SendAlertMessage)?.metadata?.channel_id ?? "",
    timeout: !!action(A.Timeout),
    timeoutSeconds: action(A.Timeout)?.metadata?.duration_seconds ?? 60,
    exemptRoles: rule?.exempt_roles ?? [],
    exemptChannels: rule?.exempt_channels ?? [],
  };
}

function bodyOf(kind: Kind, draft: Draft): AutoModerationRuleRequest {
  const actions: AutoModerationRuleRequest["actions"] = [];
  if (draft.block) actions.push({ type: A.BlockMessage, ...(draft.message.trim() ? { metadata: { custom_message: draft.message.trim() } } : {}) });
  if (draft.alert) actions.push({ type: A.SendAlertMessage, metadata: { channel_id: draft.alertChannel } });
  if (draft.timeout && kind.actions.includes(A.Timeout)) actions.push({ type: A.Timeout, metadata: { duration_seconds: draft.timeoutSeconds } });
  const trigger_metadata =
    kind.type === T.Keyword
      ? { keyword_filter: splitList(draft.keywords), allow_list: splitList(draft.allow) }
      : kind.type === T.KeywordPreset
        ? { presets: draft.presets, allow_list: splitList(draft.allow) }
        : kind.type === T.MentionSpam
          ? { mention_total_limit: draft.limit }
          : {};
  return { name: draft.name.trim(), enabled: draft.enabled, trigger_metadata, actions, exempt_roles: draft.exemptRoles, exempt_channels: draft.exemptChannels };
}

/** Why the draft cannot be saved yet, or null. */
function draftProblem(draft: Draft): string | null {
  if (!draft.name.trim()) return "Give the rule a name.";
  if (!draft.block && !draft.alert && !draft.timeout) return "Choose at least one response.";
  if (draft.alert && !draft.alertChannel) return "Choose a channel for the alert.";
  return null;
}

function ActionChips({ actions }: { actions: AutoModerationActionType[] }) {
  return (
    <span className="am-chips">
      {actions.map(a => (
        <span key={a} className="am-chip">
          {ACTION_CHIPS[a].icon}
          {ACTION_CHIPS[a].label}
        </span>
      ))}
    </span>
  );
}

/** A collapsed rule: icon, title, what it does and the actions it can take (or has), with Set Up / Edit. */
function RuleCard({ kind, rule, title, onOpen, onToggle, button }: { kind: Kind; rule: AutoModerationRule | null; title: string; onOpen(): void; onToggle?(enabled: boolean): void; button: string }) {
  return (
    <li className="am-card">
      <span className="am-card-icon" aria-hidden="true">
        {kind.icon}
      </span>
      <div className="am-card-text">
        <span className="am-card-title">{title}</span>
        <span className="am-card-desc">{kind.description}</span>
        <ActionChips actions={rule ? rule.actions.map(a => a.type) : kind.actions} />
      </div>
      {rule && onToggle && <SwitchRow label={`Enable ${rule.name}`} checked={rule.enabled} onChange={onToggle} />}
      <button type="button" className="btn btn-primary btn-sm" aria-label={`${button} ${title}`} onClick={onOpen}>
        {button}
      </button>
    </li>
  );
}

function Check({ label, note, icon, checked, onChange, children }: { label: string; note: string; icon: ReactNode; checked: boolean; onChange(next: boolean): void; children?: ReactNode }) {
  return (
    <div className={`am-action${checked ? " on" : ""}`}>
      <label className="am-action-row">
        <span className="am-action-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="am-action-text">
          <span className="am-action-label">{label}</span>
          <span className="am-action-note">{note}</span>
        </span>
        <input type="checkbox" className="am-checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      </label>
      {checked && children}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="am-step" aria-label={title}>
      <span className="am-step-n" aria-hidden="true">
        {n}
      </span>
      <div className="am-step-body">
        <h3 className="am-step-title">{title}</h3>
        {children}
      </div>
    </section>
  );
}

/** The open rule: name and switch, then Discord's three steps (configure, respond, exempt). */
function RuleEditor({ guild, kind, rule, draft, setDraft, onDelete }: { guild: Guild; kind: Kind; rule: AutoModerationRule | null; draft: Draft; setDraft(next: Draft): void; onDelete(): void }) {
  const channels = useStore(s => s.channels);
  const roles = guild.roles.filter(r => r.id !== guild.id).sort((a, b) => b.position - a.position);
  const guildChannels = useMemo(
    () => Object.values(channels).filter(c => c.guild_id === guild.id && c.type !== ChannelType.GuildCategory && c.type !== ChannelType.GuildVoice).sort((a, b) => a.position - b.position),
    [channels, guild.id],
  );
  const textChannels = guildChannels.filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement);
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  const allows = (type: AutoModerationActionType) => kind.actions.includes(type);

  return (
    <li className="am-card am-editor" aria-label={`Edit ${kind.title}`}>
      <div className="am-editor-head">
        <Field label="Rule Name">
          <input className="input" aria-label="Rule name" maxLength={100} value={draft.name} onChange={e => set({ name: e.target.value })} />
        </Field>
        <SwitchRow label="Rule enabled" checked={draft.enabled} onChange={enabled => set({ enabled })} />
        {rule && (
          <button type="button" className="ss-icon-btn" aria-label={`Delete ${rule.name}`} onClick={onDelete}>
            <Trash2 size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      {kind.type === T.MentionSpam && (
        <Step n={1} title="Set Limits">
          <div className="am-limit">
            <AtSign size={20} aria-hidden="true" />
            <span className="am-action-text">
              <span className="am-action-label">Unique mentions (role + user) per message</span>
              <span className="am-action-note">Limit the number of unique mentions in each message.</span>
            </span>
            <span className="am-stepper">
              <button type="button" className="ss-icon-btn" aria-label="Fewer mentions" disabled={draft.limit <= 1} onClick={() => set({ limit: draft.limit - 1 })}>
                <Minus size={14} aria-hidden="true" />
              </button>
              <input
                className="input"
                type="number"
                min={1}
                max={50}
                aria-label="Mention limit"
                value={draft.limit}
                onChange={e => set({ limit: Math.min(50, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
              />
              <button type="button" className="ss-icon-btn" aria-label="More mentions" disabled={draft.limit >= 50} onClick={() => set({ limit: draft.limit + 1 })}>
                <Plus size={14} aria-hidden="true" />
              </button>
            </span>
          </div>
        </Step>
      )}
      {kind.type === T.Spam && (
        <Step n={1} title="What Counts as Spam">
          <p className="settings-todo">The same text (at least 10 characters, any case) from one member for the third time within 30 seconds, in any channel. The first two copies go through.</p>
        </Step>
      )}
      {kind.type === T.KeywordPreset && (
        <Step n={1} title="Choose Categories">
          <div className="am-presets" role="group" aria-label="Word categories">
            {PRESETS.map(p => (
              <label key={p.value} className="am-preset">
                <input
                  type="checkbox"
                  className="am-checkbox"
                  checked={draft.presets.includes(p.value)}
                  onChange={e => set({ presets: e.target.checked ? [...draft.presets, p.value].sort() : draft.presets.filter(v => v !== p.value) })}
                />
                <span className="am-action-text">
                  <span className="am-action-label">{p.label}</span>
                  <span className="am-action-note">{p.note}</span>
                </span>
              </label>
            ))}
          </div>
          <Field label="Allow Words or Phrases" note="Separate with commas. These never trigger the rule.">
            <textarea className="input mod-reason" aria-label="Allowed words" value={draft.allow} onChange={e => set({ allow: e.target.value })} />
          </Field>
        </Step>
      )}
      {kind.type === T.Keyword && (
        <Step n={1} title="Define Keywords">
          <Field label="Blocked Words" note="Separate with commas. Use * at the start or end to also match longer words (cat*, *cat, *cat*).">
            <textarea className="input mod-reason" aria-label="Blocked words" value={draft.keywords} onChange={e => set({ keywords: e.target.value })} />
          </Field>
          <Field label="Allowed Words" note="Words that never trigger this rule.">
            <textarea className="input mod-reason" aria-label="Allowed words" value={draft.allow} onChange={e => set({ allow: e.target.value })} />
          </Field>
        </Step>
      )}
      <Step n={2} title="Choose a Response">
        <Check label="Block message" note="Stop the message from being posted. You can set a message shown to the member." icon={<OctagonX size={20} />} checked={draft.block} onChange={block => set({ block })}>
          <input className="input am-action-extra" aria-label="Custom message" placeholder="Custom message (optional)" maxLength={150} value={draft.message} onChange={e => set({ message: e.target.value })} />
        </Check>
        <Check label="Send alert" note="Post the flagged message to a channel you choose." icon={<Hash size={20} />} checked={draft.alert} onChange={alert => set({ alert })}>
          <div className="am-action-extra">
            <Select<string> label="Alert channel" value={draft.alertChannel} options={[{ value: "", label: "Select a channel" }, ...textChannels.map(c => ({ value: c.id, label: `#${c.name}` }))]} onChange={alertChannel => set({ alertChannel })} />
          </div>
        </Check>
        {allows(A.Timeout) && (
          <Check label="Time out member" note="Stop the member from sending messages or joining voice for a while." icon={<Timer size={20} />} checked={draft.timeout} onChange={timeout => set({ timeout })}>
            <div className="am-action-extra">
              <Select<string> label="Timeout duration" value={String(draft.timeoutSeconds)} options={TIMEOUTS.map(t => ({ value: String(t.seconds), label: t.label }))} onChange={v => set({ timeoutSeconds: Number(v) })} />
            </div>
          </Check>
        )}
      </Step>
      <Step n={3} title="Allow Certain Roles or Channels (Optional)">
        <div className="ss-chip-row" role="group" aria-label="Exempt roles">
          {roles.map(r => (
            <button key={r.id} type="button" className={`ss-role-chip ss-chip-toggle${draft.exemptRoles.includes(r.id) ? " selected" : ""}`} aria-pressed={draft.exemptRoles.includes(r.id)} onClick={() => set({ exemptRoles: toggle(draft.exemptRoles, r.id) })}>
              <span className="ss-role-dot" style={{ background: roleColor(r) }} />
              {r.name}
            </button>
          ))}
          {roles.length === 0 && <span className="settings-todo">No roles yet.</span>}
        </div>
        <div className="ss-chip-row" role="group" aria-label="Exempt channels">
          {guildChannels.map(c => (
            <button key={c.id} type="button" className={`ss-role-chip ss-chip-toggle${draft.exemptChannels.includes(c.id) ? " selected" : ""}`} aria-pressed={draft.exemptChannels.includes(c.id)} onClick={() => set({ exemptChannels: toggle(draft.exemptChannels, c.id) })}>
              #{c.name}
            </button>
          ))}
        </div>
        <p className="am-hint">
          <ShieldOff size={14} aria-hidden="true" /> Rules never apply to members who can manage the server or are administrators.
        </p>
      </Step>
    </li>
  );
}

interface Editing {
  kind: Kind;
  rule: AutoModerationRule | null;
}

/** AutoMod: Discord's four content rules (mention spam, spam, flagged words, custom words), each with block / alert / timeout responses (MANAGE_GUILD). */
export function AutoModPage({ guild, canEdit }: { guild: Guild; canEdit: boolean }) {
  const [rules, setRules] = useState<AutoModerationRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRules(await listAutomodRules(guild.id));
      setError(null);
    } catch (e) {
      setError(errorText(e));
      setRules(r => r ?? []);
    }
  }, [guild.id]);

  useEffect(() => {
    if (canEdit) void load();
  }, [load, canEdit]);

  useEffect(() => {
    const upsert = (rule: AutoModerationRule) => rule.guild_id === guild.id && setRules(prev => (prev ? [...prev.filter(r => r.id !== rule.id), rule].sort((a, b) => a.id.localeCompare(b.id)) : prev));
    const offs = [
      gateway.on("AUTO_MODERATION_RULE_CREATE", upsert),
      gateway.on("AUTO_MODERATION_RULE_UPDATE", upsert),
      gateway.on("AUTO_MODERATION_RULE_DELETE", rule => rule.guild_id === guild.id && setRules(prev => prev?.filter(r => r.id !== rule.id) ?? prev)),
    ];
    return () => offs.forEach(off => off());
  }, [guild.id]);

  const open = (kind: Kind, rule: AutoModerationRule | null) => {
    setEditing({ kind, rule });
    setDraft(draftOf(kind, rule));
    setError(null);
  };
  const close = () => {
    setEditing(null);
    setDraft(null);
    setError(null);
  };

  const run = async (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      after?.();
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!editing || !draft) return;
    const body = bodyOf(editing.kind, draft);
    const rule = editing.rule;
    void run(
      () => (rule ? updateAutomodRule(guild.id, rule.id, body) : createAutomodRule(guild.id, { ...body, event_type: AutoModerationEventType.MessageSend, trigger_type: editing.kind.type })),
      close,
    );
  };

  if (!canEdit) {
    return (
      <Page title="AutoMod">
        <Unavailable>You need the Manage Server permission to set up AutoMod.</Unavailable>
      </Page>
    );
  }

  const editor = (kind: Kind, rule: AutoModerationRule | null) =>
    editing && draft && editing.kind.type === kind.type && editing.rule?.id === rule?.id ? (
      <RuleEditor key={rule?.id ?? `new-${kind.type}`} guild={guild} kind={kind} rule={rule} draft={draft} setDraft={setDraft} onDelete={() => rule && void run(() => deleteAutomodRule(guild.id, rule.id), close)} />
    ) : null;
  const toggle = (rule: AutoModerationRule) => (enabled: boolean) => void run(() => updateAutomodRule(guild.id, rule.id, { enabled }));
  const keywordRules = rules?.filter(r => r.trigger_type === T.Keyword) ?? [];
  const problem = draft ? draftProblem(draft) : null;

  return (
    <Page title="AutoMod">
      <p className="settings-todo">Let AutoMod keep watch while your moderators rest. Set up filters that moderate content and choose what happens when a message is caught.</p>
      <Category title="Content">
        {!editing && error && <p className="field-error">{error}</p>}
        {rules === null && <p className="settings-todo">Loading…</p>}
        <ul className="am-list" aria-label="AutoMod rules">
          {KINDS.map(kind => {
            if (kind.type === T.Keyword) {
              const full = keywordRules.length >= KEYWORD_RULE_LIMIT;
              return [
                editor(kind, null) ?? (
                  <RuleCard key="keyword-new" kind={kind} rule={null} title={kind.title} button={full ? "Limit Reached" : "Create"} onOpen={() => !full && open(kind, null)} />
                ),
                ...keywordRules.map(rule => editor(kind, rule) ?? <RuleCard key={rule.id} kind={kind} rule={rule} title={rule.name} button="Edit" onOpen={() => open(kind, rule)} onToggle={toggle(rule)} />),
              ];
            }
            const rule = rules?.find(r => r.trigger_type === kind.type) ?? null;
            return (
              editor(kind, rule) ?? (
                <RuleCard key={kind.type} kind={kind} rule={rule} title={rule?.name ?? kind.title} button={rule ? "Edit" : "Set Up"} onOpen={() => open(kind, rule)} onToggle={rule ? toggle(rule) : undefined} />
              )
            );
          })}
        </ul>
      </Category>
      <SaveBar visible={!!editing} busy={busy} error={editing ? (error ?? problem) : null} saveDisabled={!!problem} onReset={close} onSave={save} />
    </Page>
  );
}
