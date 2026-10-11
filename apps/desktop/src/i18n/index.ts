// App strings by locale. `t()` reads the language chosen in Settings > Language & Time (pref `locale`, "" = the device's).
// To add a language: a catalog file next to en.ts with the same keys, one LOCALES entry, and a QA pass of the settings pages.

import { usePrefs } from "../ui/prefs";
import { en, type Catalog, type StringKey } from "./en";

export type { StringKey };

export interface LocaleInfo {
  /** BCP 47 tag; also drives date and number formats. */
  id: string;
  /** Name in English. */
  label: string;
  /** Name in the language itself. */
  native: string;
  strings: Catalog;
}

export const LOCALES: readonly LocaleInfo[] = [
  { id: "en-US", label: "English, US", native: "English, US", strings: en },
  { id: "en-GB", label: "English, UK", native: "English, UK", strings: en },
];

/** The catalog for a locale tag: exact match, then the same language, then English. */
export function catalogFor(locale: string): Catalog {
  const tag = locale || (typeof navigator !== "undefined" ? navigator.language : "en-US");
  const exact = LOCALES.find(l => l.id.toLowerCase() === tag.toLowerCase());
  const language = LOCALES.find(l => l.id.split("-")[0] === tag.split("-")[0]?.toLowerCase());
  return (exact ?? language)?.strings ?? en;
}

export function t(key: StringKey, locale: string = usePrefs.getState().locale): string {
  return catalogFor(locale)[key] ?? en[key];
}

/** `t` bound to the current language; re-renders when it changes. */
export function useT(): (key: StringKey) => string {
  const locale = usePrefs(s => s.locale);
  return key => t(key, locale);
}
