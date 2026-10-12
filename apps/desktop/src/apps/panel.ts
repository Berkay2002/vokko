// The `/` command panel as data: frequently used ranking and the sections (Frequently Used, one per app, Built-in) of a query.
// Pure functions so the picker and the tests share them.
import type { Application, ApplicationCommand, Snowflake } from "../api/types";
import { BUILTIN_APP_ID, BUILTIN_APP_NAME } from "./builtins";
import { matchCommands } from "./commandParser";

export const RECENT_ID = "recent";
export const RECENT_LIMIT = 5;

export interface RecentEntry {
  count: number;
  last: number;
}
/** command id → how often and when it was last run */
export type Recents = Record<string, RecentEntry>;

export interface PanelSection {
  /** `recent`, `builtin` or `app:<id>` */
  id: string;
  kind: "recent" | "app" | "builtin";
  name: string;
  /** The app of an `app` section. */
  app?: { id: Snowflake; name: string; icon: string | null };
  commands: ApplicationCommand[];
}

export function bumpRecent(recents: Recents, commandId: string, now: number): Recents {
  return { ...recents, [commandId]: { count: (recents[commandId]?.count ?? 0) + 1, last: now } };
}

/** The most used commands (then the most recent) that are in `available`, at most `limit`. */
export function rankRecents(recents: Recents, available: readonly ApplicationCommand[], limit = RECENT_LIMIT): ApplicationCommand[] {
  return available
    .filter(c => recents[c.id])
    .sort((a, b) => recents[b.id]!.count - recents[a.id]!.count || recents[b.id]!.last - recents[a.id]!.last)
    .slice(0, limit);
}

/**
 * Sections for the typed command name, in order: Frequently Used (only while nothing is typed and something was used), each
 * app of the index, Built-in. Sections without matches are left out. `commands` already holds the built-ins.
 */
export function buildSections(commands: readonly ApplicationCommand[], applications: readonly Pick<Application, "id" | "name" | "icon">[], query: string, recents: Recents): PanelSection[] {
  const matches = matchCommands(commands, query);
  const sections: PanelSection[] = [];
  if (query === "") {
    const recent = rankRecents(recents, matches);
    if (recent.length > 0) sections.push({ id: RECENT_ID, kind: "recent", name: "Frequently Used", commands: recent });
  }
  const seen = new Set<Snowflake>();
  const appSection = (id: Snowflake, name: string, icon: string | null) => {
    seen.add(id);
    const list = matches.filter(c => c.application_id === id);
    if (list.length > 0) sections.push({ id: `app:${id}`, kind: "app", name, app: { id, name, icon }, commands: list });
  };
  for (const app of applications) appSection(app.id, app.name, app.icon);
  // Commands of an app the index does not list still show up.
  for (const id of new Set(matches.map(c => c.application_id))) if (id !== BUILTIN_APP_ID && !seen.has(id)) appSection(id, "App", null);
  const builtin = matches.filter(c => c.application_id === BUILTIN_APP_ID);
  if (builtin.length > 0) sections.push({ id: "builtin", kind: "builtin", name: BUILTIN_APP_NAME, commands: builtin });
  return sections;
}

const RECENTS_KEY = "vokko.slash-recents";

/** The recents of a user from localStorage (empty when missing or unreadable). */
export function loadRecents(userId: Snowflake | null | undefined): Recents {
  if (!userId) return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(`${RECENTS_KEY}.${userId}`) ?? "null") as Recents | null;
    if (!parsed || typeof parsed !== "object") return {};
    const clean: Recents = {};
    for (const [id, e] of Object.entries(parsed)) {
      if (e && typeof e === "object" && Number.isFinite(e.count) && Number.isFinite(e.last)) clean[id] = { count: e.count, last: e.last };
    }
    return clean;
  } catch {
    return {};
  }
}

export function saveRecents(userId: Snowflake | null | undefined, recents: Recents): void {
  if (!userId) return;
  try {
    localStorage.setItem(`${RECENTS_KEY}.${userId}`, JSON.stringify(recents));
  } catch {
    /* storage full or blocked: recents are a nicety */
  }
}
