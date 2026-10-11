// Pure helpers of User Settings > Voice & Video (unit tested in voiceVideoHelpers.test.ts).

export interface DeviceLabelParts {
  name: string;
  /** Driver / group in the trailing parentheses, "" when there is none. */
  detail: string;
}

/** "Microphone (Realtek(R) Audio)" -> { name: "Microphone", detail: "Realtek(R) Audio" }. Only the last, balanced group counts. */
export function splitDeviceLabel(label: string): DeviceLabelParts {
  const text = label.trim();
  if (!text.endsWith(")")) return { name: text, detail: "" };
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      depth--;
      if (depth === 0) {
        const name = text.slice(0, i).trim();
        const detail = text.slice(i + 1, -1).trim();
        // "(Realtek)" alone is a name, not a detail.
        return name ? { name, detail } : { name: text, detail: "" };
      }
    }
  }
  return { name: text, detail: "" };
}

/** The meter spans the whole dBFS scale so the sensitivity slider (0-100 %) lines up with it one to one. */
export const METER_FLOOR_DB = -100;

/** How many of `count` meter segments are lit for a level in dBFS (-100..0). */
export function levelToSegments(db: number, count: number, floorDb = METER_FLOOR_DB): number {
  if (!Number.isFinite(db) || count <= 0) return 0;
  const fraction = (Math.min(0, db) - floorDb) / (0 - floorDb);
  return Math.max(0, Math.min(count, Math.round(fraction * count)));
}
