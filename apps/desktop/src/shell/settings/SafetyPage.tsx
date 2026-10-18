import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { gateway } from "../../api/gateway";
import { request } from "../../api/rest";
import { fetchInstance } from "../../auth/api";
import { appStore, useStore } from "../../api/store";
import {
  AutoModerationActionType,
  AutoModerationEventType,
  AutoModerationTriggerType,
  ChannelType,
  ExplicitContentFilter,
  VerificationLevel,
  type AutoModerationRule,
  type AutoModerationRuleRequest,
  type Guild,
} from "../../api/types";
import { Modal } from "../../ui";
import { Category, Field, Page, RadioGroup, SwitchRow, Unavailable } from "./controls";
import { createAutomodRule, deleteAutomodRule, listAutomodRules, updateAutomodRule } from "./admin";
import { SaveBar } from "./SaveBar";
import { errorText, roleColor } from "./shared";

const LOW_NOTE = "Must have a verified email on their Vokko account.";
const LEVELS: { value: string; label: string; note: string }[] = [
  { value: String(VerificationLevel.None), label: "None", note: "Unrestricted." },
  { value: String(VerificationLevel.Low), label: "Low", note: LOW_NOTE },
  { value: String(VerificationLevel.Medium), label: "Medium", note: "Must be registered on Vokko for longer than 5 minutes." },
  { value: String(VerificationLevel.High), label: "High", note: "Must also be a member of this server for longer than 10 minutes." },
  { value: String(VerificationLevel.VeryHigh), label: "Highest", note: "Same as High: Vokko has no phone verification." },
];

const FILTERS: { value: string; label: string; note: string }[] = [
  { value: String(ExplicitContentFilter.Disabled), label: "Do not filter", note: "Media is not checked." },
  { value: String(ExplicitContentFilter.MembersWithoutRoles), label: "Filter messages from server members without roles", note: "Recommended for servers that use roles for trusted members." },
  { value: String(ExplicitContentFilter.AllMembers), label: "Filter messages from all members", note: "Recommended for public servers." },
];

/** Safety Setup: verification level and explicit media filter (PATCH /guilds/{id}). */
export function SafetyPage({ guild, canEdit }: { guild: Guild; canEdit: boolean }) {
  const stored = { level: String(guild.verification_level ?? 0), filter: String(guild.explicit_content_filter ?? 0) };
  const [level, setLevel] = useState(stored.level);
  const [filter, setFilter] = useState(stored.filter);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLevel(String(guild.verification_level ?? 0));
    setFilter(String(guild.explicit_content_filter ?? 0));
  }, [guild.verification_level, guild.explicit_content_filter]);
  const dirty = level !== stored.level || filter !== stored.filter;
  // An instance that sends no mail can't verify anyone, so the server lets every account pass Low: say so.
  const [mail, setMail] = useState(true);
  useEffect(() => {
    fetchInstance().then(info => setMail(info.email_verification), () => undefined);
  }, []);
  const levels = useMemo(() => (mail ? LEVELS : LEVELS.map(l => (l.note === LOW_NOTE ? { ...l, note: `${LOW_NOTE} This instance sends no mail, so every account passes.` } : l))), [mail]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await request<Guild>("PATCH", `/guilds/${guild.id}`, { verification_level: Number(level), explicit_content_filter: Number(filter) });
      const state = appStore.getState();
      appStore.setState({ guilds: { ...state.guilds, [guild.id]: { ...state.guilds[guild.id], ...updated } } });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Safety Setup">
      {!canEdit && <Unavailable>You need the Manage Server permission to change safety settings.</Unavailable>}
      <Category title="Verification Level">
        <p className="settings-todo">Members must meet these criteria before they can send messages. Members with a role are exempt.</p>
        <RadioGroup<string> name="Verification level" value={level} options={levels} onChange={setLevel} disabled={!canEdit} />
      </Category>
      <Category title="Explicit Image Filter">
        <p className="settings-todo">The setting is saved for the server; Vokko does not scan media yet.</p>
        <RadioGroup<string> name="Explicit image filter" value={filter} options={FILTERS} onChange={setFilter} disabled={!canEdit} />
      </Category>
      <SaveBar
        visible={canEdit && (dirty || !!error)}
        busy={busy}
        error={error}
        onReset={() => {
          setLevel(stored.level);
          setFilter(stored.filter);
          setError(null);
        }}
        onSave={() => void save()}
      />
    </Page>
  );
}

const splitList = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(Boolean);

interface RuleDraft {
  name: string;
  keywords: string;
  allow: string;
  message: string;
  exemptRoles: string[];
  exemptChannels: string[];
}

const draftOf = (rule: AutoModerationRule | null): RuleDraft => ({
  name: rule?.name ?? "Block Custom Words",
  keywords: rule?.trigger_metadata.keyword_filter.join(", ") ?? "",
  allow: rule?.trigger_metadata.allow_list.join(", ") ?? "",
  message: rule?.actions[0]?.metadata?.custom_message ?? "",
  exemptRoles: rule?.exempt_roles ?? [],
  exemptChannels: rule?.exempt_channels ?? [],
});

function RuleEditor({ guild, rule, onClose }: { guild: Guild; rule: AutoModerationRule | null; onClose(): void }) {
  const channels = useStore(s => s.channels);
  const [draft, setDraft] = useState<RuleDraft>(() => draftOf(rule));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roles = guild.roles.filter(r => r.id !== guild.id).sort((a, b) => b.position - a.position);
  const guildChannels = useMemo(
    () => Object.values(channels).filter(c => c.guild_id === guild.id && c.type !== ChannelType.GuildCategory && c.type !== ChannelType.GuildVoice).sort((a, b) => a.position - b.position),
    [channels, guild.id],
  );
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]);

  const save = async () => {
    setBusy(true);
    setError(null);
    const body: AutoModerationRuleRequest = {
      name: draft.name.trim(),
      trigger_metadata: { keyword_filter: splitList(draft.keywords), allow_list: splitList(draft.allow) },
      actions: [{ type: AutoModerationActionType.BlockMessage, ...(draft.message.trim() ? { metadata: { custom_message: draft.message.trim() } } : {}) }],
      exempt_roles: draft.exemptRoles,
      exempt_channels: draft.exemptChannels,
    };
    try {
      if (rule) await updateAutomodRule(guild.id, rule.id, body);
      else await createAutomodRule(guild.id, { ...body, event_type: AutoModerationEventType.MessageSend, trigger_type: AutoModerationTriggerType.Keyword, enabled: true });
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={rule ? "Edit Keyword Rule" : "Create Keyword Rule"}
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !draft.name.trim()} onClick={() => void save()}>
            Save Rule
          </button>
        </>
      }
    >
      <Field label="Rule Name">
        <input className="input" aria-label="Rule name" maxLength={100} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
      </Field>
      <Field label="Blocked Words" note="Separate with commas. Use * at the start or end to also match longer words (cat*, *cat, *cat*).">
        <textarea className="input mod-reason" aria-label="Blocked words" value={draft.keywords} onChange={e => setDraft({ ...draft, keywords: e.target.value })} />
      </Field>
      <Field label="Allowed Words" note="Words that never trigger this rule.">
        <textarea className="input mod-reason" aria-label="Allowed words" value={draft.allow} onChange={e => setDraft({ ...draft, allow: e.target.value })} />
      </Field>
      <Field label="Custom Message" note="Shown to members when their message is blocked.">
        <input className="input" aria-label="Custom message" maxLength={150} value={draft.message} onChange={e => setDraft({ ...draft, message: e.target.value })} />
      </Field>
      <Field label="Exempt Roles">
        <div className="ss-chip-row" role="group" aria-label="Exempt roles">
          {roles.map(r => (
            <button key={r.id} type="button" className={`ss-role-chip ss-chip-toggle${draft.exemptRoles.includes(r.id) ? " selected" : ""}`} aria-pressed={draft.exemptRoles.includes(r.id)} onClick={() => setDraft({ ...draft, exemptRoles: toggle(draft.exemptRoles, r.id) })}>
              <span className="ss-role-dot" style={{ background: roleColor(r) }} />
              {r.name}
            </button>
          ))}
          {roles.length === 0 && <span className="settings-todo">No roles yet.</span>}
        </div>
      </Field>
      <Field label="Exempt Channels">
        <div className="ss-chip-row" role="group" aria-label="Exempt channels">
          {guildChannels.map(c => (
            <button key={c.id} type="button" className={`ss-role-chip ss-chip-toggle${draft.exemptChannels.includes(c.id) ? " selected" : ""}`} aria-pressed={draft.exemptChannels.includes(c.id)} onClick={() => setDraft({ ...draft, exemptChannels: toggle(draft.exemptChannels, c.id) })}>
              #{c.name}
            </button>
          ))}
        </div>
      </Field>
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}

/** AutoMod: keyword rules that block messages (MANAGE_GUILD). */
export function AutoModPage({ guild, canEdit }: { guild: Guild; canEdit: boolean }) {
  const [rules, setRules] = useState<AutoModerationRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AutoModerationRule | "new" | null>(null);

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

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (!canEdit) {
    return (
      <Page title="AutoMod">
        <Unavailable>You need the Manage Server permission to set up AutoMod.</Unavailable>
      </Page>
    );
  }

  return (
    <Page title="AutoMod">
      <p className="settings-todo">AutoMod blocks messages that contain words you choose. Server managers and administrators are never blocked.</p>
      <Category title="Block Custom Words">
        {error && <p className="field-error">{error}</p>}
        {rules === null && <p className="settings-todo">Loading…</p>}
        <ul className="ss-holder-list" aria-label="Keyword rules">
          {rules?.map(rule => (
            <li key={rule.id} className="ss-automod-rule">
              <div className="ss-member-text">
                <span className="ss-member-display">{rule.name}</span>
                <span className="ss-member-username">
                  {rule.trigger_metadata.keyword_filter.length} {rule.trigger_metadata.keyword_filter.length === 1 ? "word" : "words"}
                  {rule.exempt_roles.length > 0 ? ` · ${rule.exempt_roles.length} exempt ${rule.exempt_roles.length === 1 ? "role" : "roles"}` : ""}
                </span>
              </div>
              <SwitchRow label={`Enable ${rule.name}`} checked={rule.enabled} onChange={enabled => void run(() => updateAutomodRule(guild.id, rule.id, { enabled }))} />
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(rule)}>
                Edit
              </button>
              <button type="button" className="ss-icon-btn" aria-label={`Delete ${rule.name}`} onClick={() => void run(() => deleteAutomodRule(guild.id, rule.id))}>
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        {rules?.length === 0 && <p className="settings-todo">No keyword rules yet.</p>}
        <button type="button" className="btn btn-primary btn-sm" disabled={(rules?.length ?? 0) >= 6} onClick={() => setEditing("new")}>
          <Plus size={14} aria-hidden="true" /> Create Keyword Rule
        </button>
      </Category>
      {editing && (
        <RuleEditor
          guild={guild}
          rule={editing === "new" ? null : editing}
          onClose={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </Page>
  );
}
