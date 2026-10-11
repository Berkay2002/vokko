/**
 * Community colour themes: one small palette per theme. `derive.ts` maps a palette onto every semantic token,
 * `generate.ts` turns the result into `src/styles/themes.generated.css` (committed; `npm run themes` rewrites it).
 *
 * Hex values are the upstream palette values (see THEMES.md for sources and licences). Levels the upstream palette does not
 * define (the darker rail/sidebar steps, a lighter surface for light themes) are written as `mix()` of upstream values.
 * Surface ladder, dark to high: bg0 = server rail / frame, bg1 = channel list, bg2 = chat, bg3 = modals/cards/embeds, bg4 = hover/selected.
 */
import { mix } from "./color";

export type ThemeBase = "dark" | "light";

export const COMMUNITY_THEME_IDS = ["dracula", "gruvbox-dark", "nord", "catppuccin-mocha", "tokyo-night", "one-dark", "solarized-dark", "rose-pine", "monokai", "catppuccin-latte", "gruvbox-light", "solarized-light", "rose-pine-dawn"] as const;
export type CommunityThemeId = (typeof COMMUNITY_THEME_IDS)[number];

export interface SyntaxColors {
  keyword: string;
  string: string;
  number: string;
  title: string;
  type: string;
  symbol: string;
  comment: string;
  deletion: string;
}

export interface Palette {
  bg0: string;
  bg1: string;
  bg2: string;
  bg3: string;
  bg4: string;
  /** Headings and the most prominent text. */
  fgStrong: string;
  /** Body text. */
  fg: string;
  /** Secondary text and default icon colour. */
  fgSubtle: string;
  /** Timestamps, placeholders, muted labels. */
  fgMuted: string;
  /** Brand colour: primary buttons, selected states, rings. */
  accent: string;
  link: string;
  good: string;
  warn: string;
  bad: string;
  info: string;
  syn: SyntaxColors;
}

export interface ThemeSource {
  /** Upstream project name. */
  name: string;
  url: string;
  licence: string;
  note?: string;
}

export interface ThemeDef {
  id: CommunityThemeId;
  label: string;
  base: ThemeBase;
  palette: Palette;
  source: ThemeSource;
}

const BLACK = "#000000";
const WHITE = "#ffffff";

const dracula: Palette = (() => {
  const bg = "#282a36";
  const line = "#44475a";
  const fg = "#f8f8f2";
  return {
    bg0: mix(bg, BLACK, 0.4),
    bg1: mix(bg, BLACK, 0.2),
    bg2: bg,
    bg3: mix(bg, line, 0.45),
    bg4: line,
    fgStrong: fg,
    fg: mix(fg, bg, 0.08),
    fgSubtle: mix(fg, "#6272a4", 0.45),
    fgMuted: "#6272a4",
    accent: "#bd93f9",
    link: "#8be9fd",
    good: "#50fa7b",
    warn: "#ffb86c",
    bad: "#ff5555",
    info: "#8be9fd",
    syn: { keyword: "#ff79c6", string: "#f1fa8c", number: "#bd93f9", title: "#50fa7b", type: "#8be9fd", symbol: "#ffb86c", comment: "#6272a4", deletion: "#ff5555" },
  };
})();

const gruvboxDark: Palette = {
  bg0: mix("#1d2021", BLACK, 0.35),
  bg1: "#1d2021",
  bg2: "#282828",
  bg3: "#3c3836",
  bg4: "#504945",
  fgStrong: "#fbf1c7",
  fg: "#ebdbb2",
  fgSubtle: "#bdae93",
  fgMuted: "#a89984",
  accent: "#fe8019",
  link: "#83a598",
  good: "#b8bb26",
  warn: "#fabd2f",
  bad: "#fb4934",
  info: "#83a598",
  syn: { keyword: "#fb4934", string: "#b8bb26", number: "#d3869b", title: "#83a598", type: "#fabd2f", symbol: "#fe8019", comment: "#928374", deletion: "#fb4934" },
};

const nord: Palette = (() => {
  const nord0 = "#2e3440";
  return {
    bg0: mix(nord0, BLACK, 0.36),
    bg1: mix(nord0, BLACK, 0.18),
    bg2: nord0,
    bg3: "#3b4252",
    bg4: "#434c5e",
    fgStrong: "#eceff4",
    fg: "#d8dee9",
    fgSubtle: mix("#d8dee9", nord0, 0.3),
    fgMuted: mix("#d8dee9", "#4c566a", 0.5),
    accent: "#88c0d0",
    link: "#81a1c1",
    good: "#a3be8c",
    warn: "#ebcb8b",
    bad: "#bf616a",
    info: "#5e81ac",
    syn: { keyword: "#81a1c1", string: "#a3be8c", number: "#b48ead", title: "#88c0d0", type: "#8fbcbb", symbol: "#d08770", comment: "#4c566a", deletion: "#bf616a" },
  };
})();

const catppuccinMocha: Palette = {
  bg0: "#11111b",
  bg1: "#181825",
  bg2: "#1e1e2e",
  bg3: "#313244",
  bg4: "#45475a",
  fgStrong: mix("#cdd6f4", WHITE, 0.35),
  fg: "#cdd6f4",
  fgSubtle: "#bac2de",
  fgMuted: "#a6adc8",
  accent: "#cba6f7",
  link: "#89b4fa",
  good: "#a6e3a1",
  warn: "#f9e2af",
  bad: "#f38ba8",
  info: "#74c7ec",
  syn: { keyword: "#cba6f7", string: "#a6e3a1", number: "#fab387", title: "#89b4fa", type: "#f9e2af", symbol: "#94e2d5", comment: "#9399b2", deletion: "#f38ba8" },
};

const tokyoNight: Palette = (() => {
  const bg = "#1a1b26";
  return {
    bg0: mix("#16161e", BLACK, 0.35),
    bg1: "#16161e",
    bg2: bg,
    bg3: "#202330",
    bg4: "#363b54",
    fgStrong: "#c0caf5",
    fg: "#a9b1d6",
    fgSubtle: "#787c99",
    fgMuted: "#565f89",
    accent: "#7aa2f7",
    link: "#7dcfff",
    good: "#9ece6a",
    warn: "#e0af68",
    bad: "#f7768e",
    info: "#2ac3de",
    syn: { keyword: "#bb9af7", string: "#9ece6a", number: "#ff9e64", title: "#7aa2f7", type: "#2ac3de", symbol: "#73daca", comment: "#565f89", deletion: "#f7768e" },
  };
})();

const oneDark: Palette = (() => {
  const bg = "#282c34";
  return {
    bg0: mix(bg, BLACK, 0.4),
    bg1: mix(bg, BLACK, 0.2),
    bg2: bg,
    bg3: "#2c313a",
    bg4: "#3e4451",
    fgStrong: "#e6e9ee", // not in Atom's One Dark: a lighter step of its foreground for headings and names
    fg: "#abb2bf",
    fgSubtle: "#828997",
    fgMuted: "#5c6370",
    accent: "#61afef",
    link: "#56b6c2",
    good: "#98c379",
    warn: "#e5c07b",
    bad: "#e06c75",
    info: "#61afef",
    syn: { keyword: "#c678dd", string: "#98c379", number: "#d19a66", title: "#61afef", type: "#e5c07b", symbol: "#56b6c2", comment: "#5c6370", deletion: "#e06c75" },
  };
})();

const solarizedDark: Palette = (() => {
  const base03 = "#002b36";
  const base02 = "#073642";
  return {
    bg0: mix(base03, BLACK, 0.5),
    bg1: mix(base03, BLACK, 0.25),
    bg2: base03,
    bg3: base02,
    bg4: mix(base02, "#586e75", 0.35),
    fgStrong: "#93a1a1",
    fg: "#839496",
    fgSubtle: mix("#839496", "#586e75", 0.35),
    fgMuted: "#586e75",
    accent: "#268bd2",
    link: "#2aa198",
    good: "#859900",
    warn: "#b58900",
    bad: "#dc322f",
    info: "#268bd2",
    syn: { keyword: "#859900", string: "#2aa198", number: "#d33682", title: "#268bd2", type: "#b58900", symbol: "#cb4b16", comment: "#586e75", deletion: "#dc322f" },
  };
})();

const rosePine: Palette = (() => {
  const base = "#191724";
  return {
    bg0: mix(base, BLACK, 0.4),
    bg1: mix(base, BLACK, 0.2),
    bg2: base,
    bg3: "#1f1d2e",
    bg4: "#26233a",
    fgStrong: mix("#e0def4", WHITE, 0.35),
    fg: "#e0def4",
    fgSubtle: "#908caa",
    fgMuted: "#6e6a86",
    accent: "#c4a7e7",
    link: "#9ccfd8",
    good: "#9ccfd8",
    warn: "#f6c177",
    bad: "#eb6f92",
    info: "#31748f",
    syn: { keyword: "#31748f", string: "#f6c177", number: "#ebbcba", title: "#c4a7e7", type: "#9ccfd8", symbol: "#ebbcba", comment: "#6e6a86", deletion: "#eb6f92" },
  };
})();

const monokai: Palette = (() => {
  const bg = "#272822";
  return {
    bg0: mix(bg, BLACK, 0.4),
    bg1: mix(bg, BLACK, 0.2),
    bg2: bg,
    bg3: "#3e3d32",
    bg4: "#49483e",
    fgStrong: "#f8f8f2",
    fg: mix("#f8f8f2", bg, 0.1),
    fgSubtle: mix("#f8f8f2", "#75715e", 0.4),
    fgMuted: "#75715e",
    accent: "#a6e22e",
    link: "#66d9ef",
    good: "#a6e22e",
    warn: "#e6db74",
    bad: "#f92672",
    info: "#66d9ef",
    syn: { keyword: "#f92672", string: "#e6db74", number: "#ae81ff", title: "#a6e22e", type: "#66d9ef", symbol: "#fd971f", comment: "#75715e", deletion: "#f92672" },
  };
})();

const catppuccinLatte: Palette = {
  bg0: "#dce0e8",
  bg1: "#e6e9ef",
  bg2: "#eff1f5",
  bg3: mix("#eff1f5", WHITE, 0.55),
  bg4: "#ccd0da",
  fgStrong: mix("#4c4f69", BLACK, 0.2),
  fg: "#4c4f69",
  fgSubtle: "#5c5f77",
  fgMuted: "#6c6f85",
  accent: "#8839ef",
  link: "#1e66f5",
  good: "#40a02b",
  warn: "#df8e1d",
  bad: "#d20f39",
  info: "#209fb5",
  syn: { keyword: "#8839ef", string: "#40a02b", number: "#fe640b", title: "#1e66f5", type: "#df8e1d", symbol: "#179299", comment: "#7c7f93", deletion: "#d20f39" },
};

const gruvboxLight: Palette = {
  bg0: "#d5c4a1",
  bg1: "#ebdbb2",
  bg2: "#fbf1c7",
  bg3: "#f9f5d7",
  bg4: "#d5c4a1",
  fgStrong: "#282828",
  fg: "#3c3836",
  fgSubtle: "#665c54",
  fgMuted: "#7c6f64",
  accent: "#af3a03",
  link: "#076678",
  good: "#79740e",
  warn: "#b57614",
  bad: "#9d0006",
  info: "#076678",
  syn: { keyword: "#9d0006", string: "#79740e", number: "#8f3f71", title: "#076678", type: "#b57614", symbol: "#427b58", comment: "#928374", deletion: "#9d0006" },
};

const solarizedLight: Palette = (() => {
  const base3 = "#fdf6e3";
  const base2 = "#eee8d5";
  return {
    bg0: mix(base2, "#93a1a1", 0.3),
    bg1: base2,
    bg2: base3,
    bg3: mix(base3, WHITE, 0.5),
    bg4: mix(base2, "#93a1a1", 0.2),
    fgStrong: "#073642",
    fg: "#586e75",
    fgSubtle: "#657b83",
    fgMuted: "#93a1a1",
    accent: "#268bd2",
    link: "#268bd2",
    good: "#859900",
    warn: "#b58900",
    bad: "#dc322f",
    info: "#2aa198",
    syn: { keyword: "#859900", string: "#2aa198", number: "#d33682", title: "#268bd2", type: "#b58900", symbol: "#cb4b16", comment: "#93a1a1", deletion: "#dc322f" },
  };
})();

const rosePineDawn: Palette = (() => {
  const base = "#faf4ed";
  const overlay = "#f2e9e1";
  return {
    bg0: mix(overlay, "#9893a5", 0.2),
    bg1: overlay,
    bg2: base,
    bg3: "#fffaf3",
    bg4: mix(overlay, "#9893a5", 0.3),
    fgStrong: mix("#464261", BLACK, 0.2),
    fg: "#464261",
    fgSubtle: "#797593",
    fgMuted: "#9893a5",
    accent: "#907aa9",
    link: "#286983",
    good: "#56949f",
    warn: "#ea9d34",
    bad: "#b4637a",
    info: "#286983",
    syn: { keyword: "#286983", string: "#ea9d34", number: "#d7827e", title: "#907aa9", type: "#56949f", symbol: "#d7827e", comment: "#9893a5", deletion: "#b4637a" },
  };
})();

const src = {
  dracula: { name: "Dracula", url: "https://github.com/dracula/dracula-theme", licence: "MIT" },
  gruvbox: { name: "Gruvbox (morhetz)", url: "https://github.com/morhetz/gruvbox", licence: "MIT/X11 (stated in the README)" },
  nord: { name: "Nord", url: "https://github.com/nordtheme/nord", licence: "MIT" },
  catppuccin: { name: "Catppuccin", url: "https://github.com/catppuccin/catppuccin", licence: "MIT" },
  tokyo: { name: "Tokyo Night (enkia/tokyo-night-vscode-theme)", url: "https://github.com/enkia/tokyo-night-vscode-theme", licence: "MIT" },
  oneDark: { name: "One Dark (Atom one-dark-syntax / one-dark-ui)", url: "https://github.com/atom/one-dark-syntax", licence: "MIT" },
  solarized: { name: "Solarized (Ethan Schoonover)", url: "https://github.com/altercation/solarized", licence: "MIT" },
  rosePine: { name: "Rosé Pine", url: "https://github.com/rose-pine/rose-pine-theme", licence: "MIT" },
  monokai: {
    name: "Monokai (Wimer Hazenberg), values as shipped in Pygments and highlight.js",
    url: "https://github.com/pygments/pygments/blob/master/pygments/styles/monokai.py",
    licence: "BSD-2-Clause (Pygments), BSD-3-Clause (highlight.js)",
    note: "Not MIT. The original Monokai colour scheme has no standalone licence; the hex values come from the BSD-licensed ports.",
  },
} satisfies Record<string, ThemeSource>;

/** Community themes in picker order: dark first, then light. */
export const COMMUNITY_THEMES: readonly ThemeDef[] = [
  { id: "dracula", label: "Dracula", base: "dark", palette: dracula, source: src.dracula },
  { id: "gruvbox-dark", label: "Gruvbox Dark", base: "dark", palette: gruvboxDark, source: src.gruvbox },
  { id: "nord", label: "Nord", base: "dark", palette: nord, source: src.nord },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", base: "dark", palette: catppuccinMocha, source: src.catppuccin },
  { id: "tokyo-night", label: "Tokyo Night", base: "dark", palette: tokyoNight, source: src.tokyo },
  { id: "one-dark", label: "One Dark", base: "dark", palette: oneDark, source: src.oneDark },
  { id: "solarized-dark", label: "Solarized Dark", base: "dark", palette: solarizedDark, source: src.solarized },
  { id: "rose-pine", label: "Rosé Pine", base: "dark", palette: rosePine, source: src.rosePine },
  { id: "monokai", label: "Monokai", base: "dark", palette: monokai, source: src.monokai },
  { id: "catppuccin-latte", label: "Catppuccin Latte", base: "light", palette: catppuccinLatte, source: src.catppuccin },
  { id: "gruvbox-light", label: "Gruvbox Light", base: "light", palette: gruvboxLight, source: src.gruvbox },
  { id: "solarized-light", label: "Solarized Light", base: "light", palette: solarizedLight, source: src.solarized },
  { id: "rose-pine-dawn", label: "Rosé Pine Dawn", base: "light", palette: rosePineDawn, source: src.rosePine },
];


