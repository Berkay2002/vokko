import { useCallback } from "react";
import { customColor } from "./a11yApply";
import { usePrefs } from "./prefs";

/**
 * Custom colours (role colours) with Settings > Accessibility > Saturation applied, when "Apply saturation to custom colours"
 * is on. UI chrome is handled at token level (a11yApply.ts); these colours come from data, so components run them through here.
 */
export function useCustomColorScale(): (color: string | null) => string | null {
  const saturation = usePrefs(s => s.saturation);
  const saturateCustomColors = usePrefs(s => s.saturateCustomColors);
  return useCallback((color: string | null) => customColor(color, { saturation, saturateCustomColors }), [saturation, saturateCustomColors]);
}

export function useCustomColor(color: string | null): string | null {
  return useCustomColorScale()(color);
}
