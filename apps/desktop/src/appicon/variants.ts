/** The app icon variants, in picker order. Ids are the file stems in `assets/app-icons` and `src-tauri/src/appicon.rs` VARIANTS (checked by tests on both sides). No imports: ui/prefs.ts validates against this. */
export const APP_ICONS = [
  { id: "default", label: "Default" },
  { id: "gradient", label: "Gradient" },
  { id: "flame", label: "Flame" },
  { id: "pastel", label: "Pastel" },
  { id: "galaxy", label: "Galaxy" },
  { id: "mono", label: "Mono" },
  { id: "inverted", label: "Inverted" },
  { id: "outline", label: "Outline" },
] as const;

export type AppIconId = (typeof APP_ICONS)[number]["id"];

export const DEFAULT_APP_ICON: AppIconId = "default";

export function isAppIconId(value: unknown): value is AppIconId {
  return APP_ICONS.some(icon => icon.id === value);
}
