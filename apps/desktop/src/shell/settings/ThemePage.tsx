import { useState } from "react";
import { Category, Field, Page, SwitchRow } from "./controls";
import { DEVICE_NOTE, HEX_RE, useDeviceSetting } from "./deviceSettings";

const PRESETS: { id: string; label: string; primary: string; accent: string }[] = [
  { id: "midnight", label: "Midnight", primary: "#1e2240", accent: "#5865f2" },
  { id: "forest", label: "Forest", primary: "#12301f", accent: "#57d28f" },
  { id: "ember", label: "Ember", primary: "#3a1414", accent: "#f47b84" },
  { id: "sunset", label: "Sunset", primary: "#3a2a10", accent: "#ffd166" },
  { id: "ocean", label: "Ocean", primary: "#0d2a40", accent: "#74b7f5" },
  { id: "orchid", label: "Orchid", primary: "#3a1636", accent: "#e47fd2" },
  { id: "dusk", label: "Dusk", primary: "#251a40", accent: "#b79bf0" },
  { id: "lagoon", label: "Lagoon", primary: "#0f3331", accent: "#8fe3df" },
];

const DEFAULT_THEME = { enabled: false, preset: "midnight" as string, primary: PRESETS[0]!.primary, accent: PRESETS[0]!.accent };

export function ThemePage({ guildId, canEdit }: { guildId: string; canEdit: boolean }) {
  const [theme, setTheme] = useDeviceSetting(guildId, "theme", DEFAULT_THEME);
  const [primaryText, setPrimaryText] = useState(theme.primary);
  const [accentText, setAccentText] = useState(theme.accent);
  const disabled = !canEdit;
  const update = (patch: Partial<typeof theme>) => setTheme({ ...theme, ...patch });
  const choose = (id: string, primary: string, accent: string) => {
    setPrimaryText(primary);
    setAccentText(accent);
    update({ preset: id, primary, accent });
  };

  return (
    <Page title="Server Theme">
      {!canEdit && <p className="settings-todo">You need the Manage Server permission to change the server theme.</p>}
      <p className="settings-todo">Pick a preset theme or build your own. Every member sees this theme when they open the server.</p>
      <SwitchRow label="Enable Server Theme" checked={theme.enabled} disabled={disabled} onChange={enabled => update({ enabled })} />
      <Category title="Select your theme">
        <div className="ss-theme-grid" role="radiogroup" aria-label="Theme presets">
          {PRESETS.map(p => (
            <button key={p.id} type="button" role="radio" aria-checked={theme.preset === p.id} aria-label={p.label} disabled={disabled} className={`ss-theme-card${theme.preset === p.id ? " selected" : ""}`} onClick={() => choose(p.id, p.primary, p.accent)}>
              <span className="ss-theme-swatch" style={{ background: `linear-gradient(135deg, ${p.primary} 60%, ${p.accent} 60%)` }} />
              <span className="ss-theme-label">{p.label}</span>
            </button>
          ))}
          <button type="button" role="radio" aria-checked={theme.preset === "custom"} aria-label="Custom Theme" disabled={disabled} className={`ss-theme-card${theme.preset === "custom" ? " selected" : ""}`} onClick={() => update({ preset: "custom" })}>
            <span className="ss-theme-swatch" style={{ background: `linear-gradient(135deg, ${theme.primary} 60%, ${theme.accent} 60%)` }} />
            <span className="ss-theme-label">Custom Theme</span>
          </button>
        </div>
        {theme.preset === "custom" && (
          <div className="ss-color-inputs">
            <Field label="Primary">
              <input
                className="input"
                aria-label="Theme primary color"
                value={primaryText}
                maxLength={7}
                disabled={disabled}
                onChange={e => {
                  setPrimaryText(e.target.value);
                  if (HEX_RE.test(e.target.value)) update({ primary: e.target.value });
                }}
              />
              {!HEX_RE.test(primaryText) && <p className="field-error">Use a hex color like #1e2240.</p>}
            </Field>
            <Field label="Accent">
              <input
                className="input"
                aria-label="Theme accent color"
                value={accentText}
                maxLength={7}
                disabled={disabled}
                onChange={e => {
                  setAccentText(e.target.value);
                  if (HEX_RE.test(e.target.value)) update({ accent: e.target.value });
                }}
              />
              {!HEX_RE.test(accentText) && <p className="field-error">Use a hex color like #5865f2.</p>}
            </Field>
          </div>
        )}
      </Category>
      <Category title="Preview">
        <div className="ss-theme-preview" aria-label="Server theme preview" style={{ background: theme.primary, borderColor: theme.accent }}>
          <span className="ss-theme-preview-title" style={{ color: theme.accent }}>
            # general
          </span>
          <span className="ss-theme-preview-body">{theme.enabled ? "Members see this theme in your server." : "Server Theme is off."}</span>
        </div>
      </Category>
      <p className="settings-todo">{DEVICE_NOTE}</p>
    </Page>
  );
}
