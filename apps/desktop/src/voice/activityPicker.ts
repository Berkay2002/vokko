// Pure parts of the Activities picker: search, the Recent row and its per-account storage.

export interface Searchable {
  id: string;
  name: string;
  description: string;
}

export const MAX_RECENT = 8;
export const recentKey = (userId: string): string => `vokko.recentActivities.${userId}`;

/** Items whose name or description contains every word of the query (case-insensitive); an empty query keeps them all in order. */
export function filterActivities<T extends Searchable>(items: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  return items.filter(i => {
    const text = `${i.name} ${i.description}`.toLowerCase();
    return words.every(w => text.includes(w));
  });
}

/** The launched id first, no duplicates, capped. */
export function pushRecent(ids: readonly string[], id: string, max = MAX_RECENT): string[] {
  return [id, ...ids.filter(i => i !== id)].slice(0, max);
}

/** Recent ids, newest first, that are still on offer (another server's game or a removed one drops out). */
export function orderRecent<T extends { id: string }>(items: readonly T[], ids: readonly string[]): T[] {
  return ids.flatMap(id => items.find(i => i.id === id) ?? []);
}

export function loadRecent(userId: string | null): string[] {
  if (!userId) return [];
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(recentKey(userId)) ?? "[]");
    return Array.isArray(saved) ? saved.filter((i): i is string => typeof i === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return []; // no storage or a corrupt entry
  }
}

export function saveRecent(userId: string | null, ids: readonly string[]): void {
  if (!userId) return;
  try {
    localStorage.setItem(recentKey(userId), JSON.stringify(ids));
  } catch {
    /* blocked or full storage: Recent just doesn't persist */
  }
}
