// Quick switcher query parsing and ranking (pure; QuickSwitcher.tsx renders it).

export type Scope = "all" | "users" | "text" | "voice" | "servers" | "unavailable";

export const PREFIXES: Record<string, Scope> = { "@": "users", "#": "text", "!": "voice", "*": "servers", $: "unavailable" };

/** "#gen" → text channels matching "gen". The prefix only counts as the first character. */
export function parseQuery(raw: string): { scope: Scope; text: string } {
  const trimmed = raw.trim();
  const scope = PREFIXES[trimmed.charAt(0)];
  return scope ? { scope, text: trimmed.slice(1).trim().toLowerCase() } : { scope: "all", text: trimmed.toLowerCase() };
}

/** 0 = no match. Exact > prefix > word start > substring > in-order letters (fewer gaps rank higher). `query` is lower case. */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const t = target.toLowerCase();
  if (t === query) return 100;
  if (t.startsWith(query)) return 80;
  const at = t.indexOf(query);
  if (at > 0) return /[\s\-_.]/.test(t.charAt(at - 1)) ? 60 : 40;
  let gaps = 0;
  let from = 0;
  for (const ch of query) {
    const i = t.indexOf(ch, from);
    if (i < 0) return 0;
    if (i > from) gaps += 1;
    from = i + 1;
  }
  return Math.max(1, 30 - gaps * 3);
}

export interface Rankable {
  label: string;
  sub?: string;
  /** Position in the recently visited list, newest 0; absent when not visited. */
  recent?: number;
  unread?: boolean;
  mentions?: number;
}

export const RECENT_BOOST = 20;

/** Matches sorted best first; recent visits, mentions and unreads lift a result among similar matches. */
export function rank<T extends Rankable>(items: T[], query: string, limit = 12): T[] {
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    // The secondary text (server name, username) counts at half weight, and only as a substring: loose letters there flood the list.
    const sub = fuzzyScore(query, item.sub ?? "");
    const base = Math.max(fuzzyScore(query, item.label), sub >= 40 ? sub / 2 : 0);
    if (base < 1) continue;
    const boost = (item.recent !== undefined ? RECENT_BOOST - item.recent : 0) + (item.mentions ? 10 : 0) + (item.unread ? 5 : 0);
    scored.push({ item, score: base + boost });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.item);
}
