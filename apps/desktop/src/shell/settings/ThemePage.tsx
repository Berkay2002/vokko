import { useState, type CSSProperties } from "react";
import { request } from "../../api/rest";
import { appStore, useStore } from "../../api/store";
import type { Guild } from "../../api/types";
import { HEX_COLOR_RE, PROFILE_THEMES, hexToInt, intToHex } from "../../perks/catalog";
import { Category, Page } from "./controls";
import { SaveBar } from "./SaveBar";
import { errorText } from "./shared";
import { ColorField } from "./TagPage";

interface ThemeDraft {
  preset: string | null;
  primary: string;
  accent: string;
}

const FIRST = PROFILE_THEMES[0]!;
const hexOf = (n: number) => intToHex(n);

function draftOf(guild: Guild | undefined): ThemeDraft | null {
  const t = guild?.theme;
  return t ? { preset: t.preset, primary: hexOf(t.primary), accent: hexOf(t.accent) } : null;
}

const same = (a: ThemeDraft | null, b: ThemeDraft | null) =>
  a === b || (!!a && !!b && a.preset === b.preset && a.primary.toLowerCase() === b.primary.toLowerCase() && a.accent.toLowerCase() === b.accent.toLowerCase());

export function ThemePage({ guildId, canEdit }: { guildId: string; canEdit: boolean }) {
  const guild = useStore(s => s.guilds[guildId]);
  const saved = draftOf(guild);
  const [draft, setDraft] = useState<ThemeDraft | null>(saved);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const disabled = !canEdit || state.busy;
  const shown: ThemeDraft = draft ?? { preset: FIRST.id, primary: hexOf(FIRST.colors[0]), accent: hexOf(FIRST.colors[1]) };
  const valid = HEX_COLOR_RE.test(shown.primary) && HEX_COLOR_RE.test(shown.accent);

  const send = async (theme: Record<string, unknown> | null): Promise<void> => {
    setState({ busy: true, error: null });
    try {
      const next = await request<Guild>("PATCH", `/guilds/${guildId}`, { theme });
      const s = appStore.getState();
      appStore.setState({ guilds: { ...s.guilds, [next.id]: { ...s.guilds[next.id], ...next } } });
      setDraft(draftOf(next));
      setState({ busy: false, error: null });
    } catch (e) {
      setState({ busy: false, error: errorText(e) });
    }
  };

  const save = () => {
    if (!draft || !valid) return setState({ busy: false, error: "Colors must be hex values like #3b3f8f." });
    void send({ preset: draft.preset, primary: hexToInt(draft.primary), accent: hexToInt(draft.accent) });
  };

  const choose = (id: string, colors: [number, number]) => setDraft({ preset: id, primary: hexOf(colors[0]), accent: hexOf(colors[1]) });
  const editColor = (patch: Partial<Pick<ThemeDraft, "primary" | "accent">>) => setDraft({ ...shown, ...patch, preset: null });
  const gradient = valid ? `linear-gradient(135deg, ${shown.primary}, ${shown.accent})` : undefined;
  const dirty = !same(draft, saved);

  return (
    <Page title="Server Theme">
      {!canEdit && <p className="settings-todo">You need Manage Server to change the server theme.</p>}
      <p className="settings-todo">Pick a preset or choose your own colors. The theme tints the server name header in the channel list for every member.</p>
      <Category title="Select your theme">
        <div className="ss-theme-grid" role="radiogroup" aria-label="Theme presets">
          {PROFILE_THEMES.map(p => {
            const on = draft?.preset === p.id;
            return (
              <button key={p.id} type="button" role="radio" aria-checked={on} aria-label={p.name} disabled={disabled} className={`ss-theme-card${on ? " selected" : ""}`} onClick={() => choose(p.id, p.colors)}>
                <span className="ss-theme-swatch" style={{ background: `linear-gradient(135deg, ${intToHex(p.colors[0])}, ${intToHex(p.colors[1])})` }} />
                <span className="ss-theme-label">{p.name}</span>
              </button>
            );
          })}
        </div>
        <div className="ss-color-inputs">
          <ColorField label="Primary" value={shown.primary} disabled={disabled} onChange={primary => editColor({ primary })} />
          <ColorField label="Accent" value={shown.accent} disabled={disabled} onChange={accent => editColor({ accent })} />
        </div>
      </Category>
      <Category title="Preview">
        <div className="ss-theme-preview-header" aria-label="Server theme preview">
          <div className={`ss-theme-preview-strip${draft && gradient ? " themed" : ""}`} style={draft && gradient ? ({ "--guild-theme-gradient": gradient } as CSSProperties) : undefined}>
            <span className="ss-theme-preview-name">{guild?.name ?? "Server"}</span>
          </div>
        </div>
        {!draft && <p className="settings-todo">No theme is set. Pick a preset or edit a color to create one.</p>}
      </Category>
      {canEdit && saved && (
        <button type="button" className="btn btn-danger btn-sm" disabled={state.busy} onClick={() => void send(null)}>
          Remove theme
        </button>
      )}
      <SaveBar visible={canEdit && (dirty || state.error !== null)} busy={state.busy} error={state.error} onReset={() => (setDraft(saved), setState({ busy: false, error: null }))} onSave={save} />
    </Page>
  );
}
