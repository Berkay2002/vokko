import type { Prefs } from "./prefs";
import { saturateColor } from "./a11y";
import { applyZoom } from "./zoom";

/**
 * Side effects of the accessibility settings on <html>: classes and variables that styles/a11y.css and the components read.
 * Called from prefs.ts `apply()`, so it also runs on the login page and after the theme changes.
 */

const media = (query: string) => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null);
const systemContrast = media("(prefers-contrast: more)");

/** The user turned high contrast on, or "Sync contrast settings" is on and the OS asks for more contrast. */
export function highContrastActive(prefs: Pick<Prefs, "highContrast" | "syncContrast">): boolean {
  return prefs.highContrast || (prefs.syncContrast && !!systemContrast?.matches);
}

/** Re-runs `onChange` when the OS contrast preference flips (only matters while "Sync contrast settings" is on). */
export function watchSystemContrast(onChange: () => void): void {
  systemContrast?.addEventListener("change", onChange);
}

// ---- saturation: lower the chroma of the colour tokens, never of images or video ----

/** Custom properties that hold colours, found once in the loaded stylesheets (tokens.css and the theme files). */
let tokenNames: string[] | null = null;
/** How many stylesheets `tokenNames` was collected from (the dev server adds them while the app starts). */
let tokenSheets = -1;
/** Tokens currently overridden inline on <html>. */
let overridden: string[] = [];
let lastSignature = "";

function collectTokenNames(): string[] {
  const names = new Set<string>();
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        if (!/(^|[\s,])(:root|html|\.theme-)/.test(rule.selectorText)) continue;
        for (let i = 0; i < rule.style.length; i += 1) {
          const name = rule.style.item(i);
          if (name.startsWith("--")) names.add(name);
        }
      } else if ("cssRules" in rule) {
        visit((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      /* a cross-origin sheet (fonts): no tokens in it */
    }
  }
  return [...names];
}

let retry: ReturnType<typeof setTimeout> | null = null;

function applySaturation(root: HTMLElement, percent: number, attempt = 0): void {
  const signature = `${percent}|${root.className}|${document.styleSheets.length}`;
  if (signature === lastSignature) return;
  for (const name of overridden) root.style.removeProperty(name);
  overridden = [];
  if (percent >= 100) {
    lastSignature = signature;
    return;
  }
  if (tokenNames === null || tokenSheets !== document.styleSheets.length) {
    tokenNames = collectTokenNames();
    tokenSheets = document.styleSheets.length;
  }
  if (tokenNames.length === 0) {
    // The stylesheets are not in the document yet (the dev server injects them after this module ran): try again shortly
    // instead of remembering a pass that did nothing.
    tokenNames = null;
    if (retry === null && attempt < 40) {
      retry = setTimeout(() => {
        retry = null;
        applySaturation(document.documentElement, getSaturation(), attempt + 1);
      }, 50);
    }
    return;
  }
  lastSignature = signature;
  const computed = getComputedStyle(root);
  const next: [string, string][] = [];
  for (const name of tokenNames) {
    const value = saturateColor(computed.getPropertyValue(name), percent);
    if (value !== null) next.push([name, value]);
  }
  for (const [name, value] of next) {
    root.style.setProperty(name, value);
    overridden.push(name);
  }
}

let wantedSaturation = 100;
const getSaturation = (): number => wantedSaturation;

export function applyAccessibility(prefs: Prefs): void {
  const root = document.documentElement;
  wantedSaturation = prefs.saturation;
  root.classList.toggle("high-contrast", highContrastActive(prefs));
  root.classList.toggle("switch-indicators", prefs.showSwitchIndicators);
  root.classList.toggle("plain-names", !prefs.displayNameStyles);
  applyZoom(prefs.zoom);
  // After the classes: the signature includes the theme and contrast classes, whose token values the pass reads.
  applySaturation(root, prefs.saturation);
}

/** A custom colour (role colour) as the user wants to see it: scaled with the saturation setting when "apply to custom colours" is on. */
export function customColor(color: string | null, prefs: Pick<Prefs, "saturation" | "saturateCustomColors">): string | null {
  if (!color || !prefs.saturateCustomColors || prefs.saturation >= 100) return color;
  return saturateColor(color, prefs.saturation) ?? color;
}
