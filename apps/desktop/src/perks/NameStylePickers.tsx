import type { DisplayNameStyles, User } from "../api/types";
import { Avatar } from "../shell/Avatar";
import { NAME_EFFECTS, NAME_FONTS, NAMEPLATES, hexToInt, intToHex, nameEffectById } from "./catalog";
import { Nameplate, StyledName } from "./NameStyles";

const DEFAULT_COLORS: [number, number] = [hexToInt("#8d96f7"), hexToInt("#f47b84")];

/** Picker grid of nameplates, each shown on a miniature member-list row. */
export function NameplateGrid({ user, name, value, onChange }: { user: Pick<User, "id" | "avatar">; name: string; value: string | null; onChange(next: string | null): void }) {
  const row = (id: string | null) => (
    <span className={`pf-nameplate-row${id ? " has-nameplate" : ""}`}>
      <Nameplate id={id} />
      <Avatar user={user} size={24} decoration={false} />
      <span className="pf-nameplate-name">{name}</span>
    </span>
  );
  return (
    <div className="pf-grid pf-grid-wide" role="radiogroup" aria-label="Nameplate">
      <button type="button" role="radio" aria-checked={value === null} className={`pf-tile${value === null ? " selected" : ""}`} onClick={() => onChange(null)}>
        {row(null)}
        <span className="pf-tile-name">None</span>
      </button>
      {NAMEPLATES.map(n => (
        <button key={n.id} type="button" role="radio" aria-checked={value === n.id} className={`pf-tile${value === n.id ? " selected" : ""}`} onClick={() => onChange(n.id)}>
          {row(n.id)}
          <span className="pf-tile-name">{n.name}</span>
        </button>
      ))}
    </div>
  );
}

/** Font, effect and colour pickers of a display name style; `null` = the plain name. */
export function DisplayNameStyleFields({ name, value, onChange }: { name: string; value: DisplayNameStyles | null; onChange(next: DisplayNameStyles | null): void }) {
  const current = value ?? { font_id: "default", effect_id: "solid", colors: [DEFAULT_COLORS[0]] };
  const effect = nameEffectById(current.effect_id);
  const colors: [number, number] = [current.colors[0] ?? DEFAULT_COLORS[0], current.colors[1] ?? current.colors[0] ?? DEFAULT_COLORS[1]];
  const update = (patch: Partial<DisplayNameStyles>) => {
    const next = { ...current, ...patch };
    const uses = nameEffectById(next.effect_id)?.colors ?? 1;
    const pair: [number, number] = [next.colors[0] ?? colors[0], next.colors[1] ?? colors[1]];
    onChange({ ...next, colors: uses === 2 ? pair : [pair[0]] });
  };
  return (
    <div className="pf-name-style">
      <div className="pf-grid pf-grid-wide" role="radiogroup" aria-label="Display name font">
        {NAME_FONTS.map(f => {
          const selected = !!value && current.font_id === f.id;
          return (
            <button key={f.id} type="button" role="radio" aria-checked={selected} className={`pf-tile${selected ? " selected" : ""}`} onClick={() => update({ font_id: f.id })}>
              <StyledName className="pf-name-sample" styles={{ ...current, font_id: f.id }}>{name}</StyledName>
              <span className="pf-tile-name">{f.name}</span>
            </button>
          );
        })}
      </div>
      <div className="pf-grid pf-grid-wide" role="radiogroup" aria-label="Display name effect">
        {NAME_EFFECTS.map(e => {
          const selected = !!value && current.effect_id === e.id;
          return (
            <button key={e.id} type="button" role="radio" aria-checked={selected} className={`pf-tile${selected ? " selected" : ""}`} onClick={() => update({ effect_id: e.id })}>
              <StyledName className="pf-name-sample" styles={{ ...current, effect_id: e.id, colors }}>{name}</StyledName>
              <span className="pf-tile-name">{e.name}</span>
            </button>
          );
        })}
      </div>
      <div className="account-inline pf-theme-custom">
        <label className="pf-color-label">
          Colour
          <input type="color" className="pf-color" aria-label="Display name colour" value={intToHex(colors[0])} onChange={e => update({ colors: [hexToInt(e.target.value), colors[1]] })} />
        </label>
        {effect?.colors === 2 && (
          <label className="pf-color-label">
            Second colour
            <input type="color" className="pf-color" aria-label="Display name second colour" value={intToHex(colors[1])} onChange={e => update({ colors: [colors[0], hexToInt(e.target.value)] })} />
          </label>
        )}
        <button type="button" className="btn btn-link btn-sm" disabled={!value} onClick={() => onChange(null)}>
          Clear
        </button>
      </div>
    </div>
  );
}

export const sameNameStyle = (a: DisplayNameStyles | null, b: DisplayNameStyles | null): boolean =>
  (!a && !b) || (!!a && !!b && a.font_id === b.font_id && a.effect_id === b.effect_id && a.colors.length === b.colors.length && a.colors.every((c, i) => c === b.colors[i]));
