import { useEffect, useMemo, useState } from "react";
import { ApiRequestError } from "../../api/errors";
import { request } from "../../api/rest";
import { appStore, useStore } from "../../api/store";
import { ChannelType, JoinMode, NsfwLevel, type Guild, type MemberVerificationForm } from "../../api/types";
import { Category, Field, Page, Select, SwitchRow, Unavailable } from "./controls";
import { JoinFormEditor, formDraft, formFromDraft, type FormDraft } from "./JoinFormEditor";
import { SaveBar } from "./SaveBar";
import { errorText } from "./shared";

const NO_RULES = "none";
const MODES = [
  { label: "Invite Only", note: "People can only join with an invite link.", mode: JoinMode.InviteOnly },
  { label: "Apply to Join", note: "People fill in a form and a moderator approves them before they get in.", mode: JoinMode.ApplyToJoin },
  { label: "Discoverable", note: "Not available yet", mode: null },
];
const EMPTY_FORM: MemberVerificationForm = { description: null, form_fields: [] };

/** Access: join mode, the Apply to Join form (PUT /guilds/{id}/member-verification), age restriction and rules channel (PATCH /guilds/{id}). */
export function AccessPage({ guild, canEdit }: { guild: Guild; canEdit: boolean }) {
  const channels = useStore(s => s.channels);
  const rulesId = guild.rules_channel_id && channels[guild.rules_channel_id]?.type === ChannelType.GuildText ? guild.rules_channel_id : NO_RULES;
  const stored = { nsfw: guild.nsfw_level === NsfwLevel.AgeRestricted, rules: rulesId, joinMode: guild.join_mode ?? JoinMode.InviteOnly };
  const [joinMode, setJoinMode] = useState<number>(stored.joinMode);
  const [storedForm, setStoredForm] = useState<MemberVerificationForm | null>(null);
  const [form, setForm] = useState<FormDraft>(formDraft(EMPTY_FORM));
  const [nsfw, setNsfw] = useState(stored.nsfw);
  const [rules, setRules] = useState(stored.rules);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    request<MemberVerificationForm>("GET", `/guilds/${guild.id}/member-verification`).then(
      f => {
        if (!live) return;
        setStoredForm(f);
        setForm(formDraft(f));
      },
      e => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [guild.id]);
  useEffect(() => {
    setJoinMode(guild.join_mode ?? JoinMode.InviteOnly);
    setNsfw(guild.nsfw_level === NsfwLevel.AgeRestricted);
    setRules(rulesId);
  }, [guild.nsfw_level, guild.join_mode, rulesId]);
  const canonical = storedForm ? JSON.stringify(formFromDraft(formDraft(storedForm))) : null;
  const formDirty = canonical !== null && JSON.stringify(formFromDraft(form)) !== canonical;
  const dirty = nsfw !== stored.nsfw || rules !== stored.rules || joinMode !== stored.joinMode || formDirty;
  const options = useMemo(
    () => [
      { value: NO_RULES, label: "No rules channel" },
      ...Object.values(channels)
        .filter(c => c.guild_id === guild.id && c.type === ChannelType.GuildText)
        .sort((a, b) => a.position - b.position)
        .map(c => ({ value: c.id, label: `# ${c.name ?? c.id}` })),
    ],
    [channels, guild.id],
  );

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (formDirty) {
        const next = formFromDraft(form);
        if (next.form_fields.some(f => f.field_type !== "TERMS" && !f.label)) throw new Error("Every question needs a label.");
        // The form first: applicants must never meet Apply to Join without it.
        const saved = await request<MemberVerificationForm>("PUT", `/guilds/${guild.id}/member-verification`, next);
        setStoredForm(saved);
        setForm(formDraft(saved));
      }
      if (joinMode !== stored.joinMode) body.join_mode = joinMode;
      if (nsfw !== stored.nsfw) body.nsfw_level = nsfw ? NsfwLevel.AgeRestricted : NsfwLevel.Default;
      if (rules !== stored.rules) body.rules_channel_id = rules === NO_RULES ? null : rules;
      if (Object.keys(body).length > 0) {
        const updated = await request<Guild>("PATCH", `/guilds/${guild.id}`, body);
        const state = appStore.getState();
        appStore.setState({ guilds: { ...state.guilds, [guild.id]: { ...state.guilds[guild.id], ...updated } } });
      }
    } catch (e) {
      setError(e instanceof Error && !(e instanceof ApiRequestError) ? e.message : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Access">
      {!canEdit && <Unavailable>You need the Manage Server permission to change access settings.</Unavailable>}
      <Category title="Access Options">
        <div className="sr-group" role="radiogroup" aria-label="Access mode">
          {MODES.map(m => (
            <button
              key={m.label}
              type="button"
              role="radio"
              aria-checked={m.mode === joinMode}
              aria-disabled={m.mode === null || !canEdit}
              className={`sr-row${m.mode === joinMode ? " selected" : ""}`}
              onClick={() => m.mode !== null && canEdit && setJoinMode(m.mode)}
            >
              <span className="sr-dot" />
              <span className="sr-text">
                <span className="sr-label">{m.label}</span>
                <span className="sr-note">{m.note}</span>
              </span>
            </button>
          ))}
        </div>
      </Category>
      {joinMode === JoinMode.ApplyToJoin && <JoinFormEditor draft={form} onChange={setForm} disabled={!canEdit || storedForm === null} />}
      <Category title="Age-Restricted Server">
        <SwitchRow label="Age-Restricted Server" note="Users will need to confirm they are over the legal age to view the content in this server." checked={nsfw} onChange={setNsfw} disabled={!canEdit} />
      </Category>
      <Category title="Server Rules">
        <Field label="Rules channel" note="The channel where your server rules live.">
          <Select<string> label="Rules channel" value={rules} options={options} onChange={setRules} disabled={!canEdit} />
        </Field>
      </Category>
      <SaveBar
        visible={canEdit && (dirty || !!error)}
        busy={busy}
        error={error}
        onReset={() => {
          setNsfw(stored.nsfw);
          setRules(stored.rules);
          setJoinMode(stored.joinMode);
          if (storedForm) setForm(formDraft(storedForm));
          setError(null);
        }}
        onSave={() => void save()}
      />
    </Page>
  );
}
