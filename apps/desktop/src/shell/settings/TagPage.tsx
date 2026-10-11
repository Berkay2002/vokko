import { useState } from "react";
import { request } from "../../api/rest";
import { appStore, useStore } from "../../api/store";
import type { Guild } from "../../api/types";
import { BADGES, HEX_COLOR_RE, TAG_RE, hexToInt, intToHex } from "../../perks/catalog";
import { TagChip } from "../../perks/TagChip";
import { Category, Field, Page } from "./controls";
import { SaveBar } from "./SaveBar";
import { errorText } from "./shared";

const DEFAULT_PRIMARY = "#5865f2";
const DEFAULT_SECONDARY = "#8d96f7";

/** A colour as a native picker plus a hex text box; the parent keeps the raw text so partial input is not lost. */
export function ColorField({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange(next: string): void }) {
  const valid = HEX_COLOR_RE.test(value);
  return (
    <Field label={label}>
      <div className="ss-color-field">
        <input type="color" className="ss-color-picker" aria-label={`${label} picker`} value={valid ? value.toLowerCase() : "#000000"} disabled={disabled} onChange={e => onChange(e.target.value)} />
        <input className="input" aria-label={label} value={value} maxLength={7} disabled={disabled} onChange={e => onChange(e.target.value)} />
      </div>
      {!valid && <p className="field-error">Use a hex color like #5865f2.</p>}
    </Field>
  );
}

interface TagDraft {
  tag: string;
  badge: string;
  primary: string;
  secondary: string;
}

const EMPTY: TagDraft = { tag: "", badge: BADGES[0]!.id, primary: DEFAULT_PRIMARY, secondary: DEFAULT_SECONDARY };

function draftOf(guild: Guild | undefined): TagDraft {
  const t = guild?.tag;
  return t ? { tag: t.tag, badge: t.badge, primary: intToHex(t.color_primary), secondary: intToHex(t.color_secondary) } : EMPTY;
}

export function TagPage({ guildId, canEdit }: { guildId: string; canEdit: boolean }) {
  const guild = useStore(s => s.guilds[guildId]);
  const saved = draftOf(guild);
  const hasTag = !!guild?.tag;
  const [draft, setDraft] = useState<TagDraft>(saved);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const disabled = !canEdit || state.busy;

  const dirty = draft.tag !== saved.tag || draft.badge !== saved.badge || draft.primary.toLowerCase() !== saved.primary.toLowerCase() || draft.secondary.toLowerCase() !== saved.secondary.toLowerCase();
  const tagValid = TAG_RE.test(draft.tag);
  const colorsValid = HEX_COLOR_RE.test(draft.primary) && HEX_COLOR_RE.test(draft.secondary);
  const tagError = draft.tag === "" ? null : tagValid ? null : "Tags are 1 to 4 letters or numbers.";
  const update = (patch: Partial<TagDraft>) => setDraft(d => ({ ...d, ...patch }));

  const send = async (tag: Record<string, unknown> | null): Promise<void> => {
    setState({ busy: true, error: null });
    try {
      const next = await request<Guild>("PATCH", `/guilds/${guildId}`, { tag });
      const s = appStore.getState();
      appStore.setState({ guilds: { ...s.guilds, [next.id]: { ...s.guilds[next.id], ...next } } });
      setDraft(draftOf(next));
      setState({ busy: false, error: null });
    } catch (e) {
      setState({ busy: false, error: errorText(e) });
    }
  };

  const save = () => {
    if (!tagValid) return setState({ busy: false, error: "Tags are 1 to 4 letters or numbers." });
    if (!colorsValid) return setState({ busy: false, error: "Colors must be hex values like #5865f2." });
    void send({ tag: draft.tag, badge: draft.badge, color_primary: hexToInt(draft.primary), color_secondary: hexToInt(draft.secondary) });
  };

  const previewColor = HEX_COLOR_RE.test(draft.primary) ? hexToInt(draft.primary) : 0;

  return (
    <Page title="Server Tag">
      {!canEdit && <p className="settings-todo">You need Manage Server to change the server tag.</p>}
      <p className="settings-todo">Create a tag that your server members can display next to their name.</p>
      <div className="ss-tag-preview" aria-label="Server tag preview">
        <TagChip tag={{ tag: draft.tag || "TAG", badge: draft.badge, color_primary: previewColor }} guildName={guild?.name} />
        <span className="ss-tag-preview-note">Members choose to wear this tag in User Settings &gt; Profiles.</span>
      </div>
      <Category title="Choose Name">
        <Field label="Tag" note="1 to 4 letters or numbers. Changing the tag updates it for members who wear it.">
          <input className="input ss-tag-name" aria-label="Server tag name" value={draft.tag} maxLength={8} disabled={disabled} placeholder="TAG" onChange={e => update({ tag: e.target.value })} />
          {tagError && <p className="field-error">{tagError}</p>}
        </Field>
      </Category>
      <Category title="Choose Badge">
        <div className="ss-badge-grid" role="radiogroup" aria-label="Server tag badge">
          {BADGES.map(({ id, label, Icon }) => (
            <button key={id} type="button" role="radio" aria-checked={draft.badge === id} aria-label={label} title={label} disabled={disabled} className={`ss-badge${draft.badge === id ? " selected" : ""}`} onClick={() => update({ badge: id })}>
              <Icon size={20} aria-hidden="true" />
            </button>
          ))}
        </div>
      </Category>
      <Category title="Choose Color">
        <div className="ss-color-inputs">
          <ColorField label="Primary" value={draft.primary} disabled={disabled} onChange={primary => update({ primary })} />
          <ColorField label="Secondary" value={draft.secondary} disabled={disabled} onChange={secondary => update({ secondary })} />
        </div>
      </Category>
      {canEdit && hasTag && (
        <button type="button" className="btn btn-danger btn-sm" disabled={state.busy} onClick={() => void send(null)}>
          Remove tag
        </button>
      )}
      <SaveBar visible={canEdit && (dirty || state.error !== null)} busy={state.busy} error={state.error} onReset={() => (setDraft(saved), setState({ busy: false, error: null }))} onSave={save} />
    </Page>
  );
}
