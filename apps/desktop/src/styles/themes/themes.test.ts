import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrast, over, parseColor, toHex } from "./color";
import { EXTRA_TOKENS, KEEP_BASE, TABLE_TOKENS } from "./derive";
import { deriveAll, generateThemesCss, generateThemesDoc, parseBaseSets, themeSelector } from "./generate";
import { COMMUNITY_THEMES } from "./palettes";

const stylesDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(stylesDir, "..");
const tokensCss = readFileSync(join(stylesDir, "tokens.css"), "utf8");
const sets = parseBaseSets(tokensCss);
const derived = deriveAll(tokensCss);

/** `--name` -> value for a theme as the browser resolves it: :root constants, then the base set, then the generated overrides. */
function resolved(id: string): Record<string, string> {
  const theme = derived.find(d => d.id === id)!;
  return { ...sets.root, ...(theme.base === "dark" ? sets.dark : sets.light), ...theme.tokens };
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.(css|tsx?)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe("generated files are current", () => {
  const update = !!process.env.UPDATE_THEMES;
  const cssPath = join(stylesDir, "themes.generated.css");
  const docPath = join(stylesDir, "THEMES.md");
  it("themes.generated.css", () => {
    const css = generateThemesCss(tokensCss);
    if (update) writeFileSync(cssPath, css);
    expect(readFileSync(cssPath, "utf8"), "run `npm run themes`").toBe(css);
  });
  it("THEMES.md", () => {
    const doc = generateThemesDoc(tokensCss);
    if (update) writeFileSync(docPath, doc);
    expect(readFileSync(docPath, "utf8"), "run `npm run themes`").toBe(doc);
  });
});

describe("token coverage", () => {
  it("every hex token of the dark and light base sets is mapped or deliberately kept", () => {
    const missing: string[] = [];
    for (const [setName, set] of Object.entries({ dark: sets.dark, light: sets.light })) {
      for (const [name, value] of Object.entries(set)) {
        if (value.startsWith("#") && !TABLE_TOKENS.includes(name) && !KEEP_BASE.has(name)) missing.push(`${setName}: --${name} ${value}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the mapping only names tokens that exist", () => {
    const known = new Set([...Object.keys(sets.dark), ...Object.keys(sets.light)]);
    expect(TABLE_TOKENS.filter(n => !known.has(n))).toEqual([]);
    expect([...KEEP_BASE].filter(n => !known.has(n))).toEqual([]);
  });

  it("dark and light base sets define the same tokens apart from the light shadows", () => {
    const darkNames = new Set(Object.keys(sets.dark));
    const lightNames = Object.keys(sets.light).filter(n => !darkNames.has(n));
    expect(lightNames.sort()).toEqual(["elevation-high", "elevation-stroke", "shadow-border", "shadow-high", "shadow-low", "shadow-medium"]);
  });

  it("every var(--x) used by the app resolves in every community theme", () => {
    const defined = new Set<string>();
    const used = new Map<string, string>();
    for (const file of sourceFiles(srcDir)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/(?:^|[\s{;"'`])(--[\w-]+)\s*:/g)) defined.add(m[1]!.slice(2));
      for (const m of text.matchAll(/["'`](--[\w-]+)["'`]/g)) defined.add(m[1]!.slice(2)); // set at runtime with style.setProperty
      for (const m of text.matchAll(/var\(\s*--([\w-]+)\s*(,)?/g)) if (!m[2]) used.set(m[1]!, file); // var(--x, fallback) always resolves
    }
    for (const def of COMMUNITY_THEMES) {
      const have = new Set([...Object.keys(resolved(def.id)), ...defined]);
      const unresolved = [...used.keys()].filter(name => !have.has(name));
      expect(unresolved, def.id).toEqual([]);
    }
  });

  it("generated overrides only touch tokens that exist in the base set or are listed extras", () => {
    for (const theme of derived) {
      const base = theme.base === "dark" ? sets.dark : sets.light;
      const unknown = Object.keys(theme.tokens).filter(n => !(n in base) && !EXTRA_TOKENS.includes(n));
      expect(unknown, theme.id).toEqual([]);
    }
  });

  it("the native window colour (--app-frame-background) is a 6-digit hex in every theme and base set", () => {
    // src/ui/prefs.ts hands this value to Tauri's setBackgroundColor, which only takes #rrggbb here.
    for (const [name, set] of Object.entries({ dark: sets.dark, light: sets.light })) expect(set["app-frame-background"], name).toMatch(/^#[0-9a-f]{6}$/i);
    for (const def of COMMUNITY_THEMES) expect(resolved(def.id)["app-frame-background"], def.id).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("every theme has its own selector and a generated block", () => {
    const css = generateThemesCss(tokensCss);
    for (const def of COMMUNITY_THEMES) expect(css).toContain(`${themeSelector(def)} {`);
  });
});

describe("no Discord colours leak into community themes", () => {
  const blurple = new Set<string>();
  for (const set of [sets.dark, sets.light, sets.root]) {
    for (const [name, value] of Object.entries(set)) {
      if (/^#(5865f2|3a48a3|4452bb|4752c4|798df9|a9bbff|b9c8ff|525fe0|2e3c88|273478|404eb1|9db0ff|a0a9fa|2d35ad|8ca0fd|7487f8|505ddb|4654c0|94a8ff|ce8100)$/i.test(value)) blurple.add(value.toLowerCase());
      if (/^brand-[0-9]+$/.test(name)) blurple.add(value.toLowerCase());
    }
  }
  for (const def of COMMUNITY_THEMES) {
    it(def.id, () => {
      const leaks: string[] = [];
      for (const [name, value] of Object.entries(resolved(def.id))) {
        const v = value.toLowerCase().replace(/\s+/g, "");
        if (blurple.has(v) || v.startsWith("rgba(88,101,242") || v.startsWith("rgba(151,151,159") || v.startsWith("rgba(108,111,124")) leaks.push(`--${name}: ${value}`);
      }
      expect(leaks).toEqual([]);
    });
  }
});

describe("WCAG AA contrast on the generated themes", () => {
  const TEXT_ON: string[] = ["chat-background", "background-base-lower", "background-surface-high", "channeltextarea-background"];
  const TEXT: string[] = [
    "text-default",
    "text-strong",
    "text-subtle",
    "text-muted",
    "chat-text-muted",
    "interactive-text-default",
    "channel-text-area-placeholder",
    "text-link",
    "text-brand",
    "text-feedback-critical",
    "text-feedback-info",
    "text-feedback-positive",
    "text-feedback-warning",
  ];
  /** Code blocks sit on the chat, sidebar and surface backgrounds, never on the input. */
  const CODE: string[] = [
    "text-code",
    "text-code-comment",
    "text-code-keyword",
    "text-code-string",
    "text-code-number",
    "text-code-title",
    "text-code-type",
    "text-code-deletion",
    "text-code-addition",
    "syn-comment",
    "syn-keyword",
    "syn-string",
    "syn-number",
    "syn-title",
    "syn-type",
    "syn-symbol",
    "syn-deletion",
    "syn-base",
  ];
  const UI: string[] = ["interactive-icon-default", "channel-icon", "icon-default", "border-focus", "text-status-online", "text-status-dnd", "text-status-idle"];

  const hex = (value: string, backdrop: string): string => over(value, backdrop);

  for (const def of COMMUNITY_THEMES) {
    describe(def.id, () => {
      const t = resolved(def.id);
      const get = (name: string): string => {
        const value = t[name];
        if (!value) throw new Error(`--${name} missing in ${def.id}`);
        return value;
      };
      const surface = (name: string): string => toHex(parseColor(get(name)).rgb);

      it("text on chat, sidebar, surface and input is at least 4.5:1", () => {
        const failures: string[] = [];
        const checks: [string, string][] = [...TEXT.flatMap(n => TEXT_ON.map((bg): [string, string] => [n, bg])), ...CODE.flatMap(n => TEXT_ON.slice(0, 3).map((bg): [string, string] => [n, bg]))];
        for (const [name, bg] of checks) {
          const ratio = contrast(hex(get(name), surface(bg)), surface(bg));
          if (ratio < 4.5) failures.push(`--${name} on --${bg}: ${ratio.toFixed(2)}`);
        }
        expect(failures).toEqual([]);
      });

      it("icons, focus ring and status colours are at least 3:1 on chat and sidebar", () => {
        const failures: string[] = [];
        for (const name of UI) {
          for (const bg of ["chat-background", "background-base-lower"]) {
            const ratio = contrast(hex(get(name), surface(bg)), surface(bg));
            if (ratio < 3) failures.push(`--${name} on --${bg}: ${ratio.toFixed(2)}`);
          }
        }
        expect(failures).toEqual([]);
      });

      it("button text is readable on the accent, hover and active shades", () => {
        const on = surface("text-on-brand");
        expect(contrast(on, surface("control-primary-background-default")), "default").toBeGreaterThanOrEqual(4.5);
        expect(contrast(on, surface("background-brand")), "background-brand").toBeGreaterThanOrEqual(4.5);
        expect(contrast(on, surface("brand-500")), "brand-500").toBeGreaterThanOrEqual(4.5);
        expect(contrast(on, surface("brand-530")), "brand-530").toBeGreaterThanOrEqual(4.5);
        expect(contrast(on, surface("brand-560")), "brand-560 (hover)").toBeGreaterThanOrEqual(3);
        expect(contrast(on, surface("brand-600")), "brand-600 (active)").toBeGreaterThanOrEqual(3);
        expect(contrast(surface("control-primary-text-default"), surface("control-primary-background-default"))).toBeGreaterThanOrEqual(4.5);
        // the accent is a UI component on the chat surface
        expect(contrast(surface("background-brand"), surface("chat-background"))).toBeGreaterThanOrEqual(3);
      });

      it("fills that carry hard-coded white or black text keep AA", () => {
        expect(contrast("#ffffff", surface("status-danger")), "status-danger").toBeGreaterThanOrEqual(4.5);
        expect(contrast("#ffffff", surface("background-feedback-notification")), "notification").toBeGreaterThanOrEqual(4.5);
        expect(contrast("#ffffff", surface("control-connected-background-default")), "connected").toBeGreaterThanOrEqual(4.5);
        expect(contrast(surface("status-positive-text"), surface("status-positive-background")), "positive").toBeGreaterThanOrEqual(4.5);
        expect(contrast(surface("status-warning-text"), surface("status-warning-background")), "warning").toBeGreaterThanOrEqual(4.5);
      });

      it("mentions, reactions and notices are readable on their tinted backgrounds", () => {
        const failures: string[] = [];
        const backdrops = ["chat-background", "background-base-lower", "background-surface-high"].map(surface);
        for (const bd of backdrops) {
          const pairs: [string, string][] = [
            ["mention-foreground", "mention-background"],
            ["reaction-text-reacted-default", "reaction-background-reacted-default"],
            ["text-code", "background-code"],
          ];
          for (const [fg, bg] of pairs) {
            const base = hex(get(bg), bd);
            const ratio = contrast(hex(get(fg), base), base);
            if (ratio < 4.5) failures.push(`--${fg} on --${bg} over ${bd}: ${ratio.toFixed(2)}`);
          }
        }
        for (const kind of ["critical", "info", "positive", "warning"]) {
          const ratio = contrast(surface(`notice-text-${kind}`), surface(`notice-background-${kind}`));
          if (ratio < 4.5) failures.push(`notice-${kind}: ${ratio.toFixed(2)}`);
        }
        expect(failures).toEqual([]);
      });
    });
  }
});
