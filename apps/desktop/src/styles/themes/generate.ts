/**
 * Builds the committed theme CSS (`src/styles/themes.generated.css`) and the credits document (`src/styles/THEMES.md`)
 * from the palettes and the Discord base sets in tokens.css. Run `npm run themes` after editing palettes or derive.ts.
 */
import { deriveTheme, type DerivedTheme } from "./derive";
import { GRADIENT_THEMES, VEIL, VEIL_LEVELS, deriveGradientTheme, type DerivedGradient } from "./gradients";
import { COMMUNITY_THEMES, type ThemeDef } from "./palettes";

export type TokenSet = Record<string, string>;

/** Token names without the leading `--`. */
function parseBlock(body: string): TokenSet {
  const out: TokenSet = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*--([\w-]+):\s*(.+?);\s*(?:\/\*.*\*\/)?\s*$/);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/** The `theme-dark` (also `:root`) and `theme-light` value sets of tokens.css. Throws if the file layout changes. */
export function parseBaseSets(tokensCss: string): { dark: TokenSet; light: TokenSet; root: TokenSet } {
  const dark = tokensCss.match(/\n:root,\n\.theme-dark \{\n([\s\S]*?)\n\}/);
  const light = tokensCss.match(/\n\.theme-light \{\n([\s\S]*?)\n\}/);
  const root = tokensCss.match(/\n:root \{\n([\s\S]*?)\n\}/);
  if (!dark || !light || !root) throw new Error("tokens.css layout changed: cannot find the dark, light and :root blocks");
  return { dark: parseBlock(dark[1]!), light: parseBlock(light[1]!), root: parseBlock(root[1]!) };
}

export function deriveAll(tokensCss: string): DerivedTheme[] {
  const sets = parseBaseSets(tokensCss);
  return COMMUNITY_THEMES.map(def => deriveTheme(def, def.base === "dark" ? sets.dark : sets.light));
}

export function deriveGradients(tokensCss: string): DerivedGradient[] {
  const sets = parseBaseSets(tokensCss);
  return GRADIENT_THEMES.map(def => deriveGradientTheme(def, def.base === "dark" ? sets.dark : sets.light));
}

/** Specificity (0,3,0): beats `:root.theme-light`, chat.css's `:root` and `.theme-light` blocks whatever the import order. */
export const themeSelector = (def: { id: string; base: "dark" | "light" }): string => `:root.theme-${def.base}.theme-${def.id}`;

/** The veil variables (`--background-gradient-<level>`) a gradient theme's surfaces paint with; one block per base set. */
function veilCss(): string[] {
  const out: string[] = [
    "/* Discord colour themes (gradient themes, parity). The gradient is one fixed, viewport-sized image; every surface level paints a",
    "   black (dark base) or white (light base) veil over it, so surfaces read as translucent panes of one picture. Surfaces use",
    "   the `--background-gradient-<level>` variable with the solid token as its fallback, which keeps every other theme untouched. */",
    "",
  ];
  for (const base of ["dark", "light"] as const) {
    const { color, opacity } = VEIL[base];
    const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    out.push(`:root.custom-theme-background.theme-${base} {`);
    for (const level of VEIL_LEVELS) {
      const veil = `rgba(${r}, ${g}, ${b}, ${opacity[level]})`;
      out.push(`  --background-gradient-${level}: linear-gradient(${veil}, ${veil}) fixed 0 0 / cover, var(--custom-theme-background) fixed 0 0 / cover;`);
    }
    out.push("}", "");
  }
  return out;
}

export function generateThemesCss(tokensCss: string): string {
  const derived = deriveAll(tokensCss);
  const sets = parseBaseSets(tokensCss);
  const out: string[] = [
    "/* Community colour themes (Dracula, Gruvbox, Nord, ...) and Discord's gradient themes. GENERATED from src/styles/themes/palettes.ts and",
    "   gradients.ts by `npm run themes`: do not edit.",
    "   Each block starts from the Discord base set named in its selector (theme-dark or theme-light stays on <html>) and overrides only",
    "   the tokens its palette changes. Credits and licences: THEMES.md. */",
    "",
  ];
  for (const def of COMMUNITY_THEMES) {
    const theme = derived.find(d => d.id === def.id)!;
    const baseNames = Object.keys(def.base === "dark" ? sets.dark : sets.light);
    const names = [...baseNames.filter(n => n in theme.tokens), ...Object.keys(theme.tokens).filter(n => !baseNames.includes(n))];
    out.push(`/* ${def.label} (${def.base}) */`, `${themeSelector(def)} {`);
    for (const name of names) out.push(`  --${name}: ${theme.tokens[name]};`);
    out.push("}", "");
  }
  out.push(...veilCss());
  for (const theme of deriveGradients(tokensCss)) {
    const def = GRADIENT_THEMES.find(d => d.id === theme.id)!;
    out.push(`/* ${def.label} (${def.base}, gradient) */`, `${themeSelector(def)} {`);
    for (const [name, value] of Object.entries(theme.props)) out.push(`  --${name}: ${value};`);
    for (const [name, value] of Object.entries(theme.tokens)) out.push(`  --${name}: ${value};`);
    out.push("}", "");
  }
  return out.join("\n");
}

export function generateThemesDoc(tokensCss: string): string {
  const derived = deriveAll(tokensCss);
  const lines: string[] = [
    "# Community colour themes",
    "",
    "Free colour themes next to Discord's Light, Ash, Dark and Onyx (Discord sells these as a Nitro perk; Vokko does not).",
    "Generated by `npm run themes` from `src/styles/themes/palettes.ts`; do not edit by hand.",
    "",
    "Each theme is one small palette (five surface levels, four text levels, an accent, link/success/warning/danger/info colours and eight",
    "syntax colours). `src/styles/themes/derive.ts` maps it onto every semantic token of the base set named in the table, and",
    "`themes.generated.css` contains only the tokens that differ from that base. Hex values are the upstream palette values; levels the",
    "upstream palette does not define (a darker server rail, a lighter surface for light themes) are mixes of upstream values.",
    "Text colours are moved towards the theme's strongest text colour only as far as needed to reach WCAG AA (4.5:1); each move is listed",
    "under \"Shade adjustments\". The contrast tests run on the generated CSS.",
    "",
    "| Theme | Base | Upstream | Licence |",
    "| --- | --- | --- | --- |",
  ];
  for (const def of COMMUNITY_THEMES) lines.push(`| ${def.label} | ${def.base} | [${def.source.name}](${def.source.url}) | ${def.source.licence} |`);
  lines.push("", "Notes:", "");
  for (const def of COMMUNITY_THEMES) if (def.source.note) lines.push(`- **${def.label}**: ${def.source.note}`);
  lines.push("- Gruvbox: the upstream repository has no LICENSE file; its README states MIT/X11 and the maintained fork `gruvbox-community/gruvbox` is MIT.");
  lines.push("- Tokyo Night: values come from the MIT-licensed `enkia/tokyo-night-vscode-theme` (the `folke/tokyonight.nvim` port is Apache-2.0).");
  lines.push("- One Dark: Atom's `one-dark-syntax` colours converted from its `hsl()` definitions; the UI levels are mixes.");
  lines.push("- Rosé Pine Dawn: text is `#464261`, as in the current `rose-pine-palette` `palette.json`.");
  lines.push("");

  lines.push("## Palettes", "");
  for (const def of COMMUNITY_THEMES) {
    const p = def.palette;
    lines.push(`### ${def.label}`, "", `Base: \`theme-${def.base}\`. Accent \`${p.accent}\`.`, "");
    lines.push("| bg0 | bg1 | bg2 | bg3 | bg4 | text strong | text | subtle | muted |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    lines.push(`| ${[p.bg0, p.bg1, p.bg2, p.bg3, p.bg4, p.fgStrong, p.fg, p.fgSubtle, p.fgMuted].map(v => `\`${v}\``).join(" | ")} |`, "");
    lines.push("| link | good | warn | bad | info |", "| --- | --- | --- | --- | --- |");
    lines.push(`| ${[p.link, p.good, p.warn, p.bad, p.info].map(v => `\`${v}\``).join(" | ")} |`, "");
  }

  lines.push("## Shade adjustments (upstream → shipped)", "", "Only listed where a palette colour did not reach AA on the theme's own surfaces, or did not carry white/black text where the app hard-codes it.", "");
  lines.push("| Theme | Role | Upstream | Shipped |", "| --- | --- | --- | --- |");
  for (const theme of derived) {
    const def = COMMUNITY_THEMES.find(d => d.id === theme.id)!;
    for (const a of theme.adjustments) lines.push(`| ${def.label} | ${a.role} | \`${a.upstream}\` | \`${a.shipped}\` |`);
  }
  lines.push("");
  lines.push(...gradientDoc(tokensCss));
  return lines.join("\n");
}

function gradientDoc(tokensCss: string): string[] {
  const lines: string[] = [
    "## Discord colour themes (parity)",
    "",
    "The gradient themes Discord sells with Nitro (Mint Apple ... Sepia, plus Blurple Twilight), free in Vokko. The base set, angle and colour",
    "stops are Discord's. They are generated into `themes.generated.css` after the community themes, from `src/styles/themes/gradients.ts`.",
    "",
    "How a gradient theme paints:",
    "",
    "- `<html>` gets `custom-theme-background`, `theme-<base>` and `theme-<id>`. The theme block defines `--custom-theme-background` (the gradient),",
    "  `--custom-theme-primary-color` / `-secondary-color` (first and last stop), `--custom-theme-base-color` and `--custom-theme-text-color`.",
    "- The base colour is the hue of the darker (dark base) or lighter (light base) end stop at hsl(h, 100%, 5% or 90%); the text colour is the same",
    "  hue at 95% (80% for blue hues, 200 to 300 degrees) lightness on dark bases, 15% (25% for blue hues) on light ones.",
    "- Background tokens are mixed in oklab with the base colour (amount 50%), text and icon tokens with the text colour (38%). The mixes are",
    "  computed at generation time, so the contrast tests run on the result.",
    "- Layout panes (window frame, channel list, chat, member list, user panel) paint `--background-gradient-<level>`: a veil of black (dark base)",
    "  or white (light base) over the gradient, which is `fixed` to the viewport so every pane shows the same picture. Opacity per level:",
    "",
    `| Base | ${VEIL_LEVELS.join(" | ")} |`,
    `| --- | ${VEIL_LEVELS.map(() => "---").join(" | ")} |`,
    ...(["dark", "light"] as const).map(b => `| ${b} | ${VEIL_LEVELS.map(l => VEIL[b].opacity[l]).join(" | ")} |`),
    "",
    "- Popouts, modals and menus stay solid, in the tinted tokens. The accent stays Discord's blurple, as in Discord.",
    "- Text is moved towards white (dark) or black (light) only as far as needed for 4.5:1 (3:1 for icons) over every veil level and every colour",
    "  the gradient passes through; moves are listed under \"Shade adjustments (gradient themes)\".",
    "",
    "| Theme | Base | Angle | Stops |",
    "| --- | --- | --- | --- |",
  ];
  for (const def of GRADIENT_THEMES) lines.push(`| ${def.label} | ${def.base} | ${def.angle}deg | ${def.stops.map(s => `\`${s.color}\` ${s.at}%`).join(", ")} |`);
  lines.push("", "### Shade adjustments (gradient themes)", "", "| Theme | Token | Mixed | Shipped |", "| --- | --- | --- | --- |");
  for (const theme of deriveGradients(tokensCss)) {
    const def = GRADIENT_THEMES.find(d => d.id === theme.id)!;
    for (const a of theme.adjustments) lines.push(`| ${def.label} | ${a.role} | \`${a.upstream}\` | \`${a.shipped}\` |`);
  }
  lines.push("");
  return lines;
}
