import { afterEach, describe, expect, it, vi } from "vitest";
import { GROUP_GAPS } from "./prefs";
import {
  NOTIFICATION_SECONDS,
  SATURATION_STEPS,
  TTS_RATES,
  ZOOM_STEPS,
  contrastRatio,
  darkenToContrast,
  migrateStoredPrefs,
  nearestStep,
  parseColor,
  sanitizeA11y,
  saturateColor,
  stepZoom,
} from "./a11y";
import { isPlaying } from "./AnimatedMedia";
import { zoomFromKey } from "./zoom";

/** The stylesheets are read as plain text (vitest returns nothing for CSS through `?raw`; the app has no node typings). */
const fs = (await import(/* @vite-ignore */ `node:${"fs"}`)) as { existsSync(url: URL): boolean; readFileSync(url: URL, encoding: string): string };
const styles = (name: string): string => {
  const url = new URL(`../styles/${name}`, import.meta.url);
  return fs.existsSync(url) ? fs.readFileSync(url, "utf8") : "";
};
const a11yCss = styles("a11y.css");
const tokensCss = styles("tokens.css");
/** Community themes land as a generated stylesheet (src/styles/themes.generated.css); absent on branches without them. */
const generated = [styles("themes.generated.css")].filter(Boolean);

type Tokens = Record<string, string>;

function declarations(body: string): Tokens {
  const out: Tokens = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]!] = m[2]!.trim();
  return out;
}

/** Declarations of every rule whose selector list matches `selector`. */
function rules(css: string, selector: RegExp): Tokens[] {
  const out: Tokens[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.split(",").some(s => selector.test(s.trim()))) out.push(declarations(m[2]!));
  }
  return out;
}

const merge = (list: Tokens[]): Tokens => Object.assign({}, ...list);

const BUILT_IN = ["dark", "ash", "onyx", "light"] as const;

/** Every theme as the full token set the page would have with that theme's classes on <html>. */
function allThemes(): { name: string; light: boolean; tokens: Tokens }[] {
  const root = merge(rules(tokensCss, /^:root$/));
  const base = Object.fromEntries(BUILT_IN.map(id => [id, merge(rules(tokensCss, new RegExp(`^(:root)?\\.theme-${id}$`)))])) as Record<string, Tokens>;
  const themes: { name: string; light: boolean; tokens: Tokens }[] = BUILT_IN.map(id => ({ name: id, light: id === "light", tokens: { ...root, ...base[id] } }));
  for (const css of generated) {
    for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/:root\.theme-(dark|ash|onyx|light)\.theme-([a-z0-9-]+)\s*\{([^{}]*)\}/g)) {
      themes.push({ name: m[2]!, light: m[1] === "light", tokens: { ...root, ...base[m[1]!], ...declarations(m[3]!) } });
    }
  }
  return themes;
}

function resolve(tokens: Tokens, name: string, seen = new Set<string>()): string | null {
  if (seen.has(name)) return null;
  seen.add(name);
  const value = tokens[name];
  if (value === undefined) return null;
  const ref = /^var\((--[a-z0-9-]+)\)$/i.exec(value);
  return ref ? resolve(tokens, ref[1]!, seen) : value;
}

type Color = NonNullable<ReturnType<typeof parseColor>>;

/** Splits on commas that are not inside parentheses. */
function topLevelArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

/** A colour value with var() and `color-mix(in srgb, A p%, B)` followed down to a plain colour (null when it cannot be). */
function colorValue(tokens: Tokens, value: string, depth = 0): Color | null {
  if (depth > 12) return null;
  const text = value.trim();
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const ref = /^var\((--[a-z0-9-]+)\)$/i.exec(text);
  if (ref) {
    const next = resolve(tokens, ref[1]!);
    return next === null ? null : colorValue(tokens, next, depth + 1);
  }
  const mix = /^color-mix\((.*)\)$/i.exec(text);
  if (mix) {
    const [space, first, second] = topLevelArgs(mix[1]!);
    if (space !== "in srgb" || first === undefined || second === undefined) return null;
    const part = /^(.*?)(?:\s+(\d+(?:\.\d+)?)%)?$/.exec(first)!;
    const share = part[2] === undefined ? 0.5 : parseFloat(part[2]) / 100;
    const a = colorValue(tokens, part[1]!, depth + 1);
    const b = colorValue(tokens, second.replace(/\s+\d+(?:\.\d+)?%$/, ""), depth + 1);
    if (!a || !b) return null;
    const alpha = a.a * share + b.a * (1 - share);
    if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const channel = (x: number, y: number) => (x * a.a * share + y * b.a * (1 - share)) / alpha;
    return { r: channel(a.r, b.r), g: channel(a.g, b.g), b: channel(a.b, b.b), a: alpha };
  }
  return parseColor(text);
}

const colorOf = (tokens: Tokens, name: string): Color | null => {
  const value = resolve(tokens, name);
  return value === null ? null : colorValue(tokens, value);
};

const HIGH_CONTRAST = merge(rules(a11yCss, /^:root:root:root\.high-contrast$/));
/** Themes built on Light carry the theme-light class and get dark text instead of white. */
const HIGH_CONTRAST_LIGHT = merge(rules(a11yCss, /^:root:root:root\.high-contrast\.theme-light$/));

describe("accessibility prefs defaults and migration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function loadPrefs(stored: unknown) {
    vi.resetModules();
    vi.stubGlobal("localStorage", { getItem: () => (stored === undefined ? null : JSON.stringify(stored)), setItem: () => undefined });
    return (await import("./prefs")).usePrefs.getState();
  }

  it("has Discord's defaults", async () => {
    const p = await loadPrefs(undefined);
    expect(p).toMatchObject({
      fontSize: 16,
      underlineLinks: false,
      displayNameStyles: true,
      density: "default",
      messageDisplay: "cozy",
      messageGroupGap: 16,
      zoom: 100,
      saturation: 100,
      saturateCustomColors: false,
      highContrast: false,
      syncContrast: true,
      showSwitchIndicators: false,
      reducedMotionEnabled: false,
      syncReducedMotion: true,
      minNotificationDuration: 3,
      stickerAnimation: "always",
      ttsRate: 1,
      legacyChatInput: false,
    });
  });

  it.each([
    ["system", false, true],
    ["on", true, false],
    ["off", false, false],
  ])("migrates the old reducedMotion %s", async (old, enabled, sync) => {
    const p = await loadPrefs({ reducedMotion: old, fontSize: 14 });
    expect(p.reducedMotionEnabled).toBe(enabled);
    expect(p.syncReducedMotion).toBe(sync);
    expect(p.fontSize).toBe(14);
    expect("reducedMotion" in p).toBe(false);
  });

  it("keeps the new keys when both shapes are stored", () => {
    const out = migrateStoredPrefs({ reducedMotion: "on", reducedMotionEnabled: false, syncReducedMotion: true });
    expect(out).toMatchObject({ reducedMotionEnabled: false, syncReducedMotion: true });
  });

  it("brings stored values back into range", async () => {
    const p = await loadPrefs({ zoom: 999, saturation: -5, messageGroupGap: 1000, minNotificationDuration: 0, ttsRate: 50, stickerAnimation: "sometimes" });
    expect(p).toMatchObject({ zoom: 200, saturation: 0, messageGroupGap: 24, minNotificationDuration: 3, ttsRate: 2, stickerAnimation: "always" });
  });

  it("sanitizes foreign values", () => {
    expect(sanitizeA11y({ zoom: "big", saturation: NaN })).toMatchObject({ zoom: 100, saturation: 100 });
  });

  it("snaps stored values that sit between two ticks to the nearest tick", () => {
    expect(sanitizeA11y({ zoom: 120, ttsRate: 1.1, minNotificationDuration: 8 })).toMatchObject({ zoom: 125, ttsRate: 1, minNotificationDuration: 10 });
    // rates stored by the old 7-stop slider land on a stop of the 11-stop one; a tie goes towards 1.0x, not down
    const old = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(r => sanitizeA11y({ ttsRate: r }).ttsRate);
    expect(old).toEqual([0.5, 0.8, 1, 1.2, 1.4, 1.8, 2]);
    expect(sanitizeA11y({ zoom: 100, ttsRate: 1, minNotificationDuration: 3 })).toMatchObject({ zoom: 100, ttsRate: 1, minNotificationDuration: 3 });
  });
});

describe("scales and zoom steps", () => {
  it("lists Discord's tick values", () => {
    expect([...ZOOM_STEPS]).toEqual([50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200]);
    expect([...GROUP_GAPS]).toEqual([0, 4, 8, 16, 24]);
    expect([...NOTIFICATION_SECONDS]).toEqual([3, 5, 10, 15, 20]);
    expect(SATURATION_STEPS).toHaveLength(11);
    expect(TTS_RATES).toHaveLength(11);
    expect([TTS_RATES[0], TTS_RATES[TTS_RATES.length - 1]]).toEqual([0.5, 2]);
    expect(TTS_RATES).toContain(1);
  });

  it("steps zoom with Ctrl +/-/0", () => {
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(100, -1)).toBe(90);
    expect(stepZoom(200, 1)).toBe(200);
    expect(stepZoom(50, -1)).toBe(50);
    expect(stepZoom(105, 1)).toBe(110);
    expect(nearestStep(ZOOM_STEPS, 120)).toBe(125);
    const key = (init: Partial<KeyboardEvent>) => ({ key: "", code: "", ctrlKey: true, metaKey: false, altKey: false, ...init });
    expect(zoomFromKey(key({ key: "=" }), 100)).toBe(110);
    expect(zoomFromKey(key({ key: "+", code: "NumpadAdd" }), 100)).toBe(110);
    expect(zoomFromKey(key({ key: "-" }), 100)).toBe(90);
    expect(zoomFromKey(key({ key: "0" }), 150)).toBe(100);
    expect(zoomFromKey(key({ key: "=", ctrlKey: false }), 100)).toBeNull();
    expect(zoomFromKey(key({ key: "a" }), 100)).toBeNull();
  });
});

describe("saturation maths", () => {
  it("leaves 100% alone and greys 0%", () => {
    expect(saturateColor("#5865f2", 100)).toBe("#5865f2");
    const grey = parseColor(saturateColor("#5865f2", 0)!)!;
    expect(Math.abs(grey.r - grey.g)).toBeLessThan(1.5);
    expect(Math.abs(grey.g - grey.b)).toBeLessThan(1.5);
  });

  it("keeps alpha and refuses what it cannot parse", () => {
    expect(parseColor(saturateColor("rgba(210, 45, 57, 0.08)", 50)!)!.a).toBeCloseTo(0.08, 3);
    expect(saturateColor("var(--brand-500)", 50)).toBeNull();
    expect(saturateColor("linear-gradient(red, blue)", 50)).toBeNull();
  });
});

describe("animation policy", () => {
  it("plays GIFs while focused, on interaction otherwise", () => {
    expect(isPlaying("always", "gif", false, true)).toBe(true);
    expect(isPlaying("always", "gif", false, false)).toBe(false);
    expect(isPlaying("always", "gif", true, false)).toBe(true);
    expect(isPlaying("interaction", "sticker", false, true)).toBe(false);
    expect(isPlaying("interaction", "sticker", true, true)).toBe(true);
    expect(isPlaying("never", "sticker", true, true)).toBe(false);
    expect(isPlaying("always", "emoji", false, false)).toBe(true);
  });
});

describe("a11y.css", () => {
  it("never filters containers to saturate (images and video must keep their colours)", () => {
    expect(/saturate\s*\(/i.test(a11yCss)).toBe(false);
  });

  it("has no colour literals", () => {
    const withoutComments = a11yCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(withoutComments.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi)).toBeNull();
  });

  it("overrides tokens only through a selector that outranks the community theme selectors", () => {
    expect(Object.keys(HIGH_CONTRAST).length).toBeGreaterThan(20);
    // :root:root:root.high-contrast = (0,4,0); :root.theme-dark.theme-name = (0,3,0)
    expect(a11yCss).toContain(":root:root:root.high-contrast {");
  });
});

describe("high contrast token set", () => {
  const themes = allThemes();

  it("covers the gradient themes too, and high contrast takes their veils off every surface", () => {
    const names = themes.map(t => t.name);
    if (generated.length === 0) return;
    expect(names).toEqual(expect.arrayContaining(["mint-apple", "forest", "blurple-twilight"]));
    const veils = new Set<string>();
    for (const css of generated) for (const m of css.matchAll(/(--background-gradient-[a-z-]+)\s*:/g)) veils.add(m[1]!);
    expect(veils.size).toBeGreaterThan(0);
    for (const veil of veils) expect(HIGH_CONTRAST[veil], veil).toBe("initial");
  });

  it("covers every built-in theme", () => {
    expect(themes.map(t => t.name)).toEqual(expect.arrayContaining([...BUILT_IN]));
  });

  it("does not make a token refer to itself", () => {
    for (const [name, value] of Object.entries({ ...HIGH_CONTRAST, ...HIGH_CONTRAST_LIGHT })) {
      expect(value.includes(`var(${name})`), name).toBe(false);
    }
  });

  it.each(themes.map(t => [t.name, t.light, t.tokens] as const))("resolves and reaches 7:1 on %s", (_name, light, tokens) => {
    const merged = { ...tokens, ...HIGH_CONTRAST, ...(light ? HIGH_CONTRAST_LIGHT : {}) };
    const surfaces = [
      "--background-base-low",
      "--background-base-lower",
      "--background-base-lowest",
      "--chat-background",
      "--app-frame-background",
      "--background-surface-high",
      "--background-surface-higher",
      "--background-surface-highest",
      "--channeltextarea-background",
    ];
    const texts = [
      "--text-default",
      "--text-strong",
      "--text-muted",
      "--text-subtle",
      "--text-link",
      "--chat-text-muted",
      "--interactive-text-default",
      "--interactive-text-hover",
      "--interactive-text-active",
      "--channels-default",
    ];
    for (const text of texts) {
      const fg = colorOf(merged, text);
      expect(fg, `${text} is a colour`).not.toBeNull();
      expect(fg!.a, `${text} is opaque`).toBe(1);
      for (const surface of surfaces) {
        const bg = colorOf(merged, surface);
        expect(bg, `${surface} is a plain colour`).not.toBeNull();
        expect(bg!.a, `${surface} is opaque`).toBe(1);
        expect(contrastRatio(fg!, bg!), `${text} on ${surface}`).toBeGreaterThanOrEqual(7);
      }
    }
    for (const [name, value] of Object.entries(merged).filter(([n]) => n in HIGH_CONTRAST || n in HIGH_CONTRAST_LIGHT)) {
      for (const ref of value.matchAll(/var\((--[a-z0-9-]+)\)/gi)) {
        expect(resolve(merged, ref[1]!), `${name} -> ${ref[1]}`).not.toBeNull();
      }
    }
  });
});

describe("role colours on a light background", () => {
  const white = parseColor("#ffffff")!;
  it("darkens a colour below the floor just enough to reach it, keeping the hue", () => {
    const yellow = "#f1c40f"; // Discord's yellow role colour, about 1.8:1 on white
    expect(contrastRatio(parseColor(yellow)!, white)).toBeLessThan(2);
    const out = parseColor(darkenToContrast(yellow, white, 4.5))!;
    expect(contrastRatio(out, white)).toBeGreaterThanOrEqual(4.45); // rounding to bytes
    expect(contrastRatio(out, white)).toBeLessThan(4.8);
    expect(out.r / out.g).toBeCloseTo(0xf1 / 0xc4, 1);
  });
  it("leaves readable colours and non-colours alone", () => {
    expect(darkenToContrast("#1f4e8c", white, 4.5)).toBe("#1f4e8c");
    expect(darkenToContrast("var(--x)", white, 4.5)).toBe("var(--x)");
  });
});
