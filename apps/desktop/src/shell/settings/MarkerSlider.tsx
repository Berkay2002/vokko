import { useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

/**
 * Discord's accessibility slider: a thin track with a tick per allowed value, labels above the ticks (the current one is
 * highlighted) and a round knob that snaps to the ticks. Ticks sit at their value's position, so uneven scales (zoom 50..200)
 * look uneven, as in Discord. Arrow keys move to the next tick. Styles in styles/a11y.css (`.ms-*`).
 */
export interface MarkerTick {
  value: number;
  /** Text above the tick; omitted for ticks that only mark a step. */
  label?: string;
}

export interface MarkerSliderProps {
  ticks: readonly MarkerTick[];
  value: number;
  onChange(next: number): void;
  /** Accessible name. */
  label: string;
  /** Text for assistive tech and the highlighted (current) label above the knob. */
  format?: (value: number) => string;
  disabled?: boolean;
  /** Id of the element that describes the slider (the row note). */
  describedBy?: string;
}

export function MarkerSlider({ ticks, value, onChange, label, format, disabled, describedBy }: MarkerSliderProps) {
  const rail = useRef<HTMLDivElement>(null);
  const min = ticks[0]?.value ?? 0;
  const max = ticks[ticks.length - 1]?.value ?? 1;
  const span = max - min || 1;
  const pct = (v: number) => ((v - min) / span) * 100;
  // A stored value between two ticks (an old setting) steps from the nearest tick, not from the first one.
  const index = ticks.reduce((best, t, i) => (Math.abs(t.value - value) < Math.abs((ticks[best]?.value ?? value) - value) ? i : best), 0);
  const text = format ? format(value) : String(value);

  const set = (i: number) => {
    const next = ticks[Math.min(ticks.length - 1, Math.max(0, i))];
    if (next && next.value !== value) onChange(next.value);
  };

  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = rail.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const target = min + Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * span;
    let best = 0;
    ticks.forEach((t, i) => {
      if (Math.abs(t.value - target) < Math.abs((ticks[best]?.value ?? 0) - target)) best = i;
    });
    set(best);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step: Record<string, number | undefined> = { ArrowRight: 1, ArrowUp: 1, PageUp: 1, ArrowLeft: -1, ArrowDown: -1, PageDown: -1 };
    const delta = step[event.key];
    if (delta !== undefined) set(index + delta);
    else if (event.key === "Home") set(0);
    else if (event.key === "End") set(ticks.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <div className={`ms${disabled ? " disabled" : ""}`}>
      <div className="ms-rail" ref={rail}>
        <div className="ms-labels" aria-hidden="true">
          {ticks.map((t, i) => {
            const active = t.value === value;
            const shown = active ? text : t.label;
            if (!shown) return null;
            const edge = i === 0 ? " first" : i === ticks.length - 1 ? " last" : "";
            return (
              <span key={t.value} className={`ms-label${active ? " active" : ""}${edge}`} style={{ left: `${pct(t.value)}%` }}>
                {shown}
              </span>
            );
          })}
        </div>
        <div
          className="ms-track"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={label}
          aria-describedby={describedBy}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={text}
          aria-disabled={disabled || undefined}
          onKeyDown={onKeyDown}
          onPointerDown={event => {
            if (disabled) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            fromPointer(event);
          }}
          onPointerMove={event => {
            if (!disabled && event.currentTarget.hasPointerCapture(event.pointerId)) fromPointer(event);
          }}
        >
          <div className="ms-line">
            <div className="ms-fill" style={{ width: `${pct(value)}%` }} />
          </div>
          {ticks.map(t => (
            <span key={t.value} className="ms-tick" style={{ left: `${pct(t.value)}%` }} />
          ))}
          <span className="ms-knob" style={{ left: `${pct(value)}%` }} />
        </div>
      </div>
    </div>
  );
}
