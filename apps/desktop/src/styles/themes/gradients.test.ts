import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrast, luminance, parseColor, toHex } from "./color";
import { deriveGradients, generateThemesCss, parseBaseSets } from "./generate";
import { FITTED_TEXT, GRADIENT_THEMES, GRADIENT_THEME_IDS, TINTED_SURFACES, TINTED_TEXT, VEIL, VEIL_LEVELS, gradientCss, gradientSamples, isIcon, themeColors } from "./gradients";

const stylesDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(stylesDir, "..");
const tokensCss = readFileSync(join(stylesDir, "tokens.css"), "utf8");
const sets = parseBaseSets(tokensCss);
const derived = deriveGradients(tokensCss);

/** `--name` -> value for a gradient theme as the browser resolves it. */
function resolved(id: string): Record<string, string> {
  const theme = derived.find(d => d.id === id)!;
  return { ...sets.root, ...(theme.base === "dark" ? sets.dark : sets.light), ...theme.tokens, ...theme.props };
}

/** Independent of gradients.ts: a veil of `opacity` over an opaque colour. */
function composite(base: "dark" | "light", opacity: number, under: string): string {
  const [r, g, b] = parseColor(under).rgb;
  const v = base === "dark" ? 0 : 255;
  return toHex([v * opacity + r * (1 - opacity), v * opacity + g * (1 - opacity), v * opacity + b * (1 - opacity)]);
}

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) cssFiles(path, out);
    else if (entry.name.endsWith(".css") && entry.name !== "themes.generated.css") out.push(path);
  }
  return out;
}

describe("gradient theme data", () => {
  it("lists Discord's 21 colour themes in picker order, then Blurple Twilight", () => {
    expect(GRADIENT_THEMES.map(t => t.label)).toEqual([
      "Mint Apple",
      "Citrus Sherbert",
      "Retro Raincloud",
      "Hanami",
      "Sunrise",
      "Cotton Candy",
      "Lofi Vibes",
      "Desert Khaki",
      "Sunset",
      "Chroma Glow",
      "Forest",
      "Crimson",
      "Midnight Blurple",
      "Mars",
      "Dusk",
      "Under The Sea",
      "Retro Storm",
      "Neon Nights",
      "Strawberry Lemonade",
      "Aurora",
      "Sepia",
      "Blurple Twilight",
    ]);
    expect(GRADIENT_THEMES.map(t => t.id)).toEqual([...GRADIENT_THEME_IDS]);
    expect(new Set(GRADIENT_THEMES.map(t => t.id)).size).toBe(GRADIENT_THEMES.length);
  });

  it("every gradient has 2 to 5 ordered, valid stops and an angle", () => {
    for (const def of GRADIENT_THEMES) {
      expect(def.stops.length, def.id).toBeGreaterThanOrEqual(2);
      expect(def.stops.length, def.id).toBeLessThanOrEqual(5);
      for (const s of def.stops) expect(() => parseColor(s.color), `${def.id} ${s.color}`).not.toThrow();
      const positions = def.stops.map(s => s.at);
      expect([...positions].sort((a, b) => a - b), def.id).toEqual(positions);
      expect(def.angle, def.id).toBeGreaterThanOrEqual(0);
      expect(def.angle, def.id).toBeLessThanOrEqual(360);
    }
  });

  it("builds Discord's linear-gradient string (Hanami)", () => {
    const hanami = GRADIENT_THEMES.find(t => t.id === "hanami")!;
    expect(hanami.base).toBe("light");
    expect(gradientCss(hanami)).toBe("linear-gradient(38.08deg, #efaab3 3.56%, #efd696 35.49%, #a6daa2 68.78%)");
  });

  it("the veil is black on dark bases and white on light ones, one opacity per level", () => {
    expect(VEIL.dark.color).toBe("#000000");
    expect(VEIL.light.color).toBe("#ffffff");
    for (const base of ["dark", "light"] as const) for (const level of VEIL_LEVELS) expect(VEIL[base].opacity[level], `${base} ${level}`).toBeGreaterThan(0.5);
  });

  it("base and text colours follow the stops' hue at the extreme lightness", () => {
    const sunset = themeColors(GRADIENT_THEMES.find(t => t.id === "sunset")!);
    expect(sunset.primary).toBe("#48288c");
    expect(sunset.secondary).toBe("#db7f4b");
    // darker end stop (#48288c, hue 261) at l = 5%, text at l = 80% because the hue is blue-purple
    expect(luminance(sunset.baseColor)).toBeLessThan(0.02);
    expect(luminance(sunset.textColor)).toBeGreaterThan(0.3);
  });
});

describe("gradient theme tokens", () => {
  it("every tinted or fitted token is a hex token in both base sets", () => {
    const names = [...TINTED_SURFACES, ...TINTED_TEXT, ...FITTED_TEXT];
    for (const [setName, set] of Object.entries({ dark: sets.dark, light: sets.light })) {
      const bad = names.filter(n => !set[n]?.startsWith("#"));
      expect(bad, setName).toEqual([]);
    }
  });

  it("generated overrides only touch tokens of the base set", () => {
    for (const theme of derived) {
      const base = theme.base === "dark" ? sets.dark : sets.light;
      expect(Object.keys(theme.tokens).filter(n => !(n in base)), theme.id).toEqual([]);
    }
  });

  it("every var(--x) used by the app resolves in every gradient theme", () => {
    const defined = new Set<string>();
    const used = new Set<string>();
    for (const dir of [srcDir]) {
      const walk = (d: string): void => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const path = join(d, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (/\.(css|tsx?)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
            const text = readFileSync(path, "utf8");
            for (const m of text.matchAll(/(?:^|[\s{;"'`])(--[\w-]+)\s*:/g)) defined.add(m[1]!.slice(2));
            for (const m of text.matchAll(/["'`](--[\w-]+)["'`]/g)) defined.add(m[1]!.slice(2));
            for (const m of text.matchAll(/var\(\s*--([\w-]+)\s*(,)?/g)) if (!m[2]) used.add(m[1]!);
          }
        }
      };
      walk(dir);
    }
    for (const def of GRADIENT_THEMES) {
      const have = new Set([...Object.keys(resolved(def.id)), ...defined]);
      expect([...used].filter(name => !have.has(name)), def.id).toEqual([]);
    }
  });

  it("the native window colour is a 6-digit hex", () => {
    for (const def of GRADIENT_THEMES) expect(resolved(def.id)["app-frame-background"], def.id).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("every theme has a block with its gradient and both base colours, and both bases have the veil variables", () => {
    const css = generateThemesCss(tokensCss);
    for (const def of GRADIENT_THEMES) {
      const block = css.slice(css.indexOf(`:root.theme-${def.base}.theme-${def.id} {`));
      expect(block.startsWith(`:root.theme-${def.base}.theme-${def.id} {`), def.id).toBe(true);
      expect(block.split("}")[0], def.id).toContain(`--custom-theme-background: ${gradientCss(def)};`);
    }
    for (const base of ["dark", "light"]) {
      const block = css.slice(css.indexOf(`:root.custom-theme-background.theme-${base} {`)).split("}")[0]!;
      for (const level of VEIL_LEVELS) expect(block, `${base} ${level}`).toContain(`--background-gradient-${level}:`);
    }
  });

  it("surfaces only ask for veil levels that exist", () => {
    const used = new Set<string>();
    for (const file of cssFiles(srcDir)) for (const m of readFileSync(file, "utf8").matchAll(/var\(--background-gradient-([a-z-]+)/g)) used.add(m[1]!);
    expect([...used].filter(l => !(VEIL_LEVELS as readonly string[]).includes(l))).toEqual([]);
    // the shell's main panes are wired
    const shell = readFileSync(join(stylesDir, "shell.css"), "utf8");
    for (const level of ["app-frame", "low", "chat", "lowest"]) expect(shell, level).toContain(`var(--background-gradient-${level},`);
  });
});

describe("WCAG AA contrast of gradient themes", () => {
  const TEXT = ["text-default", "text-strong", "text-subtle", "text-muted", "chat-text-muted", "channel-text-area-placeholder", "text-link", "text-brand", "text-feedback-critical", "text-feedback-info", "text-feedback-positive", "text-feedback-warning"];

  for (const def of GRADIENT_THEMES) {
    describe(def.id, () => {
      const t = resolved(def.id);
      const hex = (name: string): string => toHex(parseColor(t[name]!).rgb);
      const byLuminance = [...def.stops.map(s => s.color)].sort((a, b) => luminance(a) - luminance(b));
      const extremes = [byLuminance[0]!, byLuminance[byLuminance.length - 1]!];

      it("text over the veiled darkest and lightest stop of every pane level is at least 4.5:1", () => {
        const failures: string[] = [];
        for (const level of VEIL_LEVELS) {
          for (const under of extremes) {
            const surface = composite(def.base, VEIL[def.base].opacity[level], under);
            for (const name of TEXT) {
              const ratio = contrast(hex(name), surface);
              if (ratio < 4.5) failures.push(`--${name} on ${level} over ${under}: ${ratio.toFixed(2)}`);
            }
          }
        }
        expect(failures).toEqual([]);
      });

      it("text and icons hold up over every colour the gradient passes through", () => {
        const failures: string[] = [];
        for (const level of VEIL_LEVELS) {
          for (const under of gradientSamples(def)) {
            const surface = composite(def.base, VEIL[def.base].opacity[level], under);
            for (const name of [...TINTED_TEXT, ...FITTED_TEXT]) {
              const min = isIcon(name) ? 3 : 4.5;
              const ratio = contrast(hex(name), surface);
              if (ratio < min) failures.push(`--${name} on ${level} over ${under}: ${ratio.toFixed(2)}`);
            }
          }
        }
        expect(failures).toEqual([]);
      });

      it("text on the solid tinted surfaces (popouts, modals, input) is at least 4.5:1", () => {
        const failures: string[] = [];
        for (const bg of ["chat-background", "background-base-lower", "background-surface-high", "channeltextarea-background"]) {
          for (const name of TEXT) {
            const ratio = contrast(hex(name), hex(bg));
            if (ratio < 4.5) failures.push(`--${name} on --${bg}: ${ratio.toFixed(2)}`);
          }
        }
        expect(failures).toEqual([]);
      });
    });
  }
});
