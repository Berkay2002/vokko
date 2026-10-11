import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, Plus, X } from "lucide-react";
import { Popout, useFocusTrap } from "../ui";
import type { Role, Snowflake } from "../api/types";
import { TIME_PRESETS, type TimeFilter } from "./query";

/** A popout that traps focus while open and gives it back to the button that opened it. */
export function FilterPopout({ anchor, open, onClose, label, children }: { anchor: HTMLElement | null; open: boolean; onClose(): void; label: string; children: ReactNode }) {
  return (
    <Popout anchor={anchor} open={open} onClose={onClose} side="bottom" align="start" gap={4} role="dialog" label={label} className="mp-popout">
      <Trapped>{children}</Trapped>
    </Popout>
  );
}

function Trapped({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(true, () => box.current);
  // The popout is invisible until it has been placed, so focus the first entry a frame later (the trap's own focus may miss).
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const root = box.current;
      if (root && !root.contains(document.activeElement)) root.querySelector<HTMLElement>("button:not(:disabled), input")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div ref={box} className="mp-popout-body">
      {children}
    </div>
  );
}

/** One single-choice row: label left, radio dot right. */
export function RadioRow({ label, checked, onSelect }: { label: string; checked: boolean; onSelect(): void }) {
  return (
    <button type="button" role="radio" aria-checked={checked} className="mp-option" onClick={onSelect}>
      <span className="mp-option-label">{label}</span>
      <span className={`mp-radio${checked ? " checked" : ""}`} aria-hidden="true" />
    </button>
  );
}

function CheckRow({ label, checked, onToggle, icon }: { label: string; checked: boolean; onToggle(): void; icon?: ReactNode }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} className="mp-option" onClick={onToggle}>
      {icon}
      <span className="mp-option-label">{label}</span>
      <span className={`mp-check${checked ? " checked" : ""}`} aria-hidden="true">
        {checked && <Check size={14} strokeWidth={3} />}
      </span>
    </button>
  );
}

/** All / Last hour / ... / Last 3 months, then "Custom range" with a from/to date pair. */
export function TimeFilterMenu({ value, onChange, label }: { value: TimeFilter; onChange(next: TimeFilter): void; label: string }) {
  const [customOpen, setCustomOpen] = useState(value.kind === "custom");
  const [from, setFrom] = useState(value.kind === "custom" ? value.from : "");
  const [to, setTo] = useState(value.kind === "custom" ? value.to : "");
  return (
    <div role="group" aria-label={label}>
      {TIME_PRESETS.map(preset => (
        <RadioRow key={preset.value} label={preset.label} checked={value.kind === "preset" && value.preset === preset.value} onSelect={() => onChange({ kind: "preset", preset: preset.value })} />
      ))}
      <div className="mp-separator" role="separator" />
      <button type="button" className="mp-option" aria-expanded={customOpen} onClick={() => setCustomOpen(open => !open)}>
        <span className="mp-option-label">Custom range</span>
        <ChevronRight size={16} aria-hidden="true" className={customOpen ? "mp-chevron open" : "mp-chevron"} />
      </button>
      {customOpen && (
        <form
          className="mp-range"
          onSubmit={e => {
            e.preventDefault();
            if (from || to) onChange({ kind: "custom", from, to });
          }}
        >
          <label>
            <span>From</span>
            <input type="date" className="mp-input" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} />
          </label>
          <label>
            <span>To</span>
            <input type="date" className="mp-input" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} />
          </label>
          <button type="submit" className="mp-apply" disabled={!from && !to}>
            Apply
          </button>
        </form>
      )}
    </div>
  );
}

/** Invite codes: the ones seen in results so far, plus any typed in. */
export function InviteFilterMenu({ known, value, onChange }: { known: string[]; value: string[]; onChange(next: string[]): void }) {
  const [draft, setDraft] = useState("");
  const codes = [...new Set([...known, ...value])].sort();
  const toggle = (code: string) => onChange(value.includes(code) ? value.filter(c => c !== code) : [...value, code]);
  const add = () => {
    const code = draft.trim();
    if (code && !value.includes(code)) onChange([...value, code]);
    setDraft("");
  };
  return (
    <div role="group" aria-label="Filter by join method">
      <form
        className="mp-invite-add"
        onSubmit={e => {
          e.preventDefault();
          add();
        }}
      >
        <input className="mp-input" placeholder="Invite code" aria-label="Invite code" value={draft} maxLength={100} onChange={e => setDraft(e.target.value)} />
        <button type="submit" className="mp-icon-btn" aria-label="Add invite code" disabled={!draft.trim()}>
          <Plus size={16} />
        </button>
      </form>
      {codes.length === 0 && <div className="mp-option-empty">No invite codes yet</div>}
      {codes.map(code => (
        <CheckRow key={code} label={code} checked={value.includes(code)} onToggle={() => toggle(code)} />
      ))}
      {value.length > 0 && (
        <>
          <div className="mp-separator" role="separator" />
          <button type="button" className="mp-option" onClick={() => onChange([])}>
            <span className="mp-option-label">Clear</span>
            <X size={16} aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}

const hex = (color: number) => (color ? `#${color.toString(16).padStart(6, "0")}` : "var(--text-muted)");

/** Multi-select of the guild's roles (highest first, no @everyone). */
export function RoleFilterMenu({ roles, value, onChange }: { roles: Role[]; value: Snowflake[]; onChange(next: Snowflake[]): void }) {
  const toggle = (id: Snowflake) => onChange(value.includes(id) ? value.filter(r => r !== id) : [...value, id]);
  return (
    <div role="group" aria-label="Filter by roles" className="mp-scroll">
      {roles.length === 0 && <div className="mp-option-empty">This server has no roles</div>}
      {roles.map(role => (
        <CheckRow key={role.id} label={role.name} checked={value.includes(role.id)} onToggle={() => toggle(role.id)} icon={<span className="mp-role-dot" style={{ background: hex(role.color) }} aria-hidden="true" />} />
      ))}
    </div>
  );
}

export { hex as roleHex };

/** Signals: only "New account" exists in Vokko (accounts under 7 days old). */
export function SignalFilterMenu({ checked, onToggle }: { checked: boolean; onToggle(): void }) {
  return (
    <div role="group" aria-label="Filter by signals">
      <CheckRow label="New account" checked={checked} onToggle={onToggle} />
    </div>
  );
}
