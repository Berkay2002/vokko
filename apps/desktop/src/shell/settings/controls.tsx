import type { ReactNode } from "react";
import { Dropdown } from "../../ui";

/** Building blocks shared by the user/server settings pages. Styles in src/styles/settings.css. */

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="settings-page">
      <h1>{title}</h1>
      {children}
    </div>
  );
}

export function Category({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-category">
      <h2 className="settings-category-title">{title}</h2>
      {children}
    </section>
  );
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange(next: boolean): void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch${checked ? " on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="switch-knob" />
    </button>
  );
}

export function SwitchRow({ label, note, checked, onChange, disabled }: { label: string; note?: ReactNode; checked: boolean; onChange(next: boolean): void; disabled?: boolean }) {
  return (
    <div className={`switch-row${disabled ? " disabled" : ""}`}>
      <div className="switch-row-text">
        <div className="switch-row-label">{label}</div>
        {note && <div className="switch-row-note">{note}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} label={label} />
    </div>
  );
}

export function Field({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-field">
      <div className="field-label">{label}</div>
      {children}
      {note && <div className="settings-field-note">{note}</div>}
    </div>
  );
}

/** Settings dropdown: the shared custom listbox, boxed like the old native select (`.select`). */
export function Select<T extends string>({ value, options, onChange, disabled, label }: { value: T; options: { value: T; label: string }[]; onChange(next: T): void; disabled?: boolean; label: string }) {
  return <Dropdown<T> className="select-wrap" triggerClassName="select" label={label} value={value} options={options} onChange={onChange} disabled={disabled} />;
}

export function Slider({ value, min, max, step = 1, onChange, label, format, disabled }: { value: number; min: number; max: number; step?: number; onChange(next: number): void; label: string; format?: (v: number) => string; disabled?: boolean }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="slider">
      <input type="range" aria-label={label} className="slider-input" min={min} max={max} step={step} value={value} disabled={disabled} style={{ ["--slider-fill" as string]: `${pct}%` }} onChange={e => onChange(Number(e.target.value))} />
      {format && <span className="slider-value">{format(value)}</span>}
    </div>
  );
}

/** Radio list in Discord's settings style (round dot, label, optional description). */
export function RadioGroup<T extends string>({ value, options, onChange, name, disabled }: { value: T; options: { value: T; label: string; note?: string }[]; onChange(next: T): void; name: string; disabled?: boolean }) {
  return (
    <div className="sr-group" role="radiogroup" aria-label={name}>
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} disabled={disabled} className={`sr-row${value === o.value ? " selected" : ""}`} onClick={() => onChange(o.value)}>
          <span className="sr-dot" />
          <span className="sr-text">
            <span className="sr-label">{o.label}</span>
            {o.note && <span className="sr-note">{o.note}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

export function Divider() {
  return <div className="settings-divider" />;
}

export function Unavailable({ children }: { children: ReactNode }) {
  return <div className="settings-unavailable">{children}</div>;
}
