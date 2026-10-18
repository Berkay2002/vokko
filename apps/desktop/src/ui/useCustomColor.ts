import { useCallback, useMemo } from "react";
import { darkenToContrast, parseColor, type Rgba } from "./a11y";
import { customColor } from "./a11yApply";
import { resolveTheme, themeBase, usePrefs } from "./prefs";

/** Text contrast floor for role colours on a light theme (WCAG AA): a yellow Admin name was about 2:1 on white. */
const LIGHT_MIN_CONTRAST = 4.5;
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/** The chat background the theme classes on <html> give (prefs.ts applies them before the re-render); white when it is not a plain opaque colour. */
function chatBackground(): Rgba {
  const bg = parseColor(getComputedStyle(document.documentElement).getPropertyValue("--chat-background"));
  return bg && bg.a === 1 ? bg : WHITE;
}

/**
 * Custom colours (role colours) with Settings > Accessibility > Saturation applied, when "Apply saturation to custom colours"
 * is on. UI chrome is handled at token level (a11yApply.ts); these colours come from data, so components run them through here.
 * On a light theme they are also darkened until readable on the chat background (dark themes keep them as set).
 */
export function useCustomColorScale(): (color: string | null) => string | null {
  const saturation = usePrefs(s => s.saturation);
  const saturateCustomColors = usePrefs(s => s.saturateCustomColors);
  // shortcut: "Sync with computer" is resolved at render, so an OS light/dark switch shows on the next re-render
  const theme = usePrefs(s => resolveTheme(s.theme));
  // read once per theme: this runs for every message author and member row
  const background = useMemo(() => (themeBase(theme) === "light" ? chatBackground() : null), [theme]);
  return useCallback(
    (color: string | null) => {
      const scaled = customColor(color, { saturation, saturateCustomColors });
      return scaled && background ? darkenToContrast(scaled, background, LIGHT_MIN_CONTRAST) : scaled;
    },
    [saturation, saturateCustomColors, background],
  );
}

export function useCustomColor(color: string | null): string | null {
  return useCustomColorScale()(color);
}
