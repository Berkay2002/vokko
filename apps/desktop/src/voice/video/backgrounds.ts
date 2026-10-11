// Video background model: the choice (persisted as one string in prefs), the built-in images (our own generated
// gradients, drawn as SVG and rasterised on demand) and the pure upload-cap rules the IndexedDB store applies.

export type BlurStrength = "light" | "strong";

export type BackgroundChoice =
  | { kind: "none" }
  | { kind: "blur"; strength: BlurStrength }
  | { kind: "builtin"; id: string }
  | { kind: "custom"; id: string };

export const NO_BACKGROUND: BackgroundChoice = { kind: "none" };

/** MediaPipe selfie segmentation + a box blur: radius in px of the (downscaled) frame, see @livekit/track-processors. */
export const BLUR_RADIUS: Record<BlurStrength, number> = { light: 8, strong: 20 };

export function serializeBackground(choice: BackgroundChoice): string {
  switch (choice.kind) {
    case "none":
      return "none";
    case "blur":
      return `blur-${choice.strength}`;
    default:
      return `${choice.kind}:${choice.id}`;
  }
}

export function parseBackground(raw: string): BackgroundChoice {
  if (raw === "blur-light") return { kind: "blur", strength: "light" };
  if (raw === "blur-strong") return { kind: "blur", strength: "strong" };
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const kind = raw.slice(0, colon);
    const id = raw.slice(colon + 1);
    if (id && kind === "builtin" && BUILTIN_BACKGROUNDS.some(b => b.id === id)) return { kind: "builtin", id };
    if (id && kind === "custom") return { kind: "custom", id };
  }
  return NO_BACKGROUND;
}

export interface BuiltinBackground {
  id: string;
  label: string;
  /** SVG markup, 1280x720. Colours are hsl() so the repo keeps zero hex literals outside the theme tokens. */
  svg: string;
}

function gradient(id: string, stops: [number, string][], angle = 135): string {
  const rad = (angle * Math.PI) / 180;
  const x = Math.round(50 + Math.cos(rad) * 50);
  const y = Math.round(50 + Math.sin(rad) * 50);
  const body = stops.map(([at, color]) => `<stop offset="${at}" stop-color="${color}"/>`).join("");
  return `<linearGradient id="${id}" x1="${100 - x}%" y1="${100 - y}%" x2="${x}%" y2="${y}%">${body}</linearGradient>`;
}

function scene(parts: string[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">${parts.join("")}</svg>`;
}

function circle(cx: number, cy: number, r: number, color: string, opacity: number): string {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" fill-opacity="${opacity}"/>`;
}

/** Six simple abstract backdrops: a gradient with soft shapes. Dark enough that a person in front reads clearly. */
export const BUILTIN_BACKGROUNDS: readonly BuiltinBackground[] = [
  {
    id: "dusk",
    label: "Dusk",
    svg: scene([
      `<defs>${gradient("g", [[0, "hsl(252 52% 24%)"], [1, "hsl(322 48% 34%)"]])}</defs>`,
      `<rect width="1280" height="720" fill="url(#g)"/>`,
      circle(1020, 150, 190, "hsl(330 80% 70%)", 0.18),
      circle(240, 620, 260, "hsl(262 70% 60%)", 0.16),
    ]),
  },
  {
    id: "lagoon",
    label: "Lagoon",
    svg: scene([
      `<defs>${gradient("g", [[0, "hsl(196 62% 20%)"], [1, "hsl(166 52% 32%)"]], 160)}</defs>`,
      `<rect width="1280" height="720" fill="url(#g)"/>`,
      circle(300, 140, 220, "hsl(180 70% 60%)", 0.14),
      circle(1100, 560, 280, "hsl(150 60% 55%)", 0.14),
    ]),
  },
  {
    id: "ember",
    label: "Ember",
    svg: scene([
      `<defs>${gradient("g", [[0, "hsl(8 56% 22%)"], [1, "hsl(36 64% 34%)"]], 120)}</defs>`,
      `<rect width="1280" height="720" fill="url(#g)"/>`,
      circle(980, 520, 300, "hsl(28 90% 62%)", 0.16),
      circle(180, 180, 170, "hsl(350 80% 62%)", 0.14),
    ]),
  },
  {
    id: "meadow",
    label: "Meadow",
    svg: scene([
      `<defs>${gradient("g", [[0, "hsl(120 34% 20%)"], [1, "hsl(84 40% 32%)"]], 100)}</defs>`,
      `<rect width="1280" height="720" fill="url(#g)"/>`,
      circle(220, 560, 240, "hsl(100 60% 60%)", 0.14),
      circle(1060, 160, 200, "hsl(60 70% 62%)", 0.12),
    ]),
  },
  {
    id: "slate",
    label: "Slate",
    svg: scene([
      `<defs>${gradient("g", [[0, "hsl(222 16% 16%)"], [1, "hsl(214 18% 30%)"]], 145)}</defs>`,
      `<rect width="1280" height="720" fill="url(#g)"/>`,
      circle(640, 120, 340, "hsl(210 30% 70%)", 0.08),
      circle(1140, 640, 200, "hsl(220 30% 70%)", 0.07),
    ]),
  },
  {
    id: "orchid",
    label: "Orchid",
    svg: scene([
      `<defs>${gradient("g", [[0, "hsl(292 38% 22%)"], [1, "hsl(236 46% 34%)"]], 70)}</defs>`,
      `<rect width="1280" height="720" fill="url(#g)"/>`,
      circle(1080, 120, 210, "hsl(300 70% 70%)", 0.15),
      circle(320, 600, 250, "hsl(230 70% 68%)", 0.15),
    ]),
  },
];

export function builtinById(id: string): BuiltinBackground | undefined {
  return BUILTIN_BACKGROUNDS.find(b => b.id === id);
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ---- upload cap ----

export const BACKGROUND_LIMITS = {
  /** One uploaded file (design doc: custom backgrounds up to 10 MiB). */
  maxFileBytes: 10 * 1024 * 1024,
  /** Images kept per user (design doc: 10). */
  maxCount: 10,
  /** Everything stored, after the uploads were scaled down to at most `maxEdge` px. */
  maxTotalBytes: 40 * 1024 * 1024,
  /** Longest edge a stored image keeps; a camera is at most 1080p, so more only costs memory. */
  maxEdge: 1920,
} as const;

export type UploadLimits = { [K in keyof typeof BACKGROUND_LIMITS]: number };

export interface StoredSize {
  id: string;
  size: number;
}

export type UploadPlan = { ok: true } | { ok: false; reason: "not_image" | "too_large" | "limit_reached" | "storage_full" };

/**
 * Whether a new upload may be stored. Nothing is evicted behind the user's back: a full library asks them to remove an
 * image first. `incomingBytes` is the size of the file as picked; `storedBytes` the size it will take once scaled.
 */
export function planUpload(existing: readonly StoredSize[], file: { type: string; size: number }, storedBytes = file.size, limits: UploadLimits = BACKGROUND_LIMITS): UploadPlan {
  if (!file.type.startsWith("image/")) return { ok: false, reason: "not_image" };
  if (file.size > limits.maxFileBytes) return { ok: false, reason: "too_large" };
  if (existing.length >= limits.maxCount) return { ok: false, reason: "limit_reached" };
  const total = existing.reduce((sum, e) => sum + e.size, 0);
  if (total + storedBytes > limits.maxTotalBytes) return { ok: false, reason: "storage_full" };
  return { ok: true };
}

export const UPLOAD_REFUSAL: Record<Exclude<UploadPlan, { ok: true }>["reason"], string> = {
  not_image: "That file is not an image.",
  too_large: "That image is larger than 10 MB.",
  limit_reached: "You can keep up to 10 backgrounds. Remove one first.",
  storage_full: "There is no room left for backgrounds on this device. Remove one first.",
};

/** Scale factor that fits `width` x `height` inside `maxEdge` (never above 1). */
export function fitScale(width: number, height: number, maxEdge: number = BACKGROUND_LIMITS.maxEdge): number {
  const longest = Math.max(width, height);
  return longest > maxEdge && longest > 0 ? maxEdge / longest : 1;
}
