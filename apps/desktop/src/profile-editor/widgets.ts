import type { FavoriteGameInput, GameEntryInput, ProfileWidgets, ProfileWidgetsInput } from "../api/types";

/** Limits of the board widgets (same numbers as the server and the mock). */
export const GAME_NAME_MAX = 64;
export const REASON_MAX = 190;
export const TAGS_MAX = 5;
export const TAG_MAX = 20;
export const GAMES_MAX = 20;

/** Length in code points, the way the server counts it (UTF-16 `.length` counts an emoji as two). */
export const chars = (text: string): number => [...text].length;

/** Cut to at most `max` code points; an input's `maxLength` counts UTF-16 units and would refuse text the server accepts. */
export const clip = (text: string, max: number): string => (chars(text) > max ? [...text].slice(0, max).join("") : text);

export interface WidgetImage {
  id: string;
  url: string;
}

export interface GameDraft {
  name: string;
  image: WidgetImage | null;
}

export interface FavoriteDraft extends GameDraft {
  reason: string;
  tags: string[];
}

export interface WidgetsDraft {
  favorite: FavoriteDraft | null;
  games: GameDraft[];
}

export const emptyWidgets = (): WidgetsDraft => ({ favorite: null, games: [] });

const image = (id: string | null | undefined, url: string | null | undefined): WidgetImage | null => (id && url ? { id, url } : null);

export function widgetsFromUser(widgets: ProfileWidgets | null | undefined): WidgetsDraft {
  const favorite = widgets?.favorite_game;
  return {
    favorite: favorite ? { name: favorite.name, image: image(favorite.image_attachment_id, favorite.image), reason: favorite.reason ?? "", tags: [...(favorite.tags ?? [])] } : null,
    games: (widgets?.games_i_like ?? []).map(g => ({ name: g.name, image: image(g.image_attachment_id, g.image) })),
  };
}

const gameInput = (g: GameDraft): GameEntryInput => ({ name: g.name.trim(), image_attachment_id: g.image?.id ?? null });

/** The PATCH value: null when no widget is left (clears the field). Names, reasons and tags are trimmed, blank tags dropped. */
export function widgetsToInput(draft: WidgetsDraft): ProfileWidgetsInput | null {
  const out: ProfileWidgetsInput = {};
  if (draft.favorite) {
    const favorite: FavoriteGameInput = {
      ...gameInput(draft.favorite),
      reason: draft.favorite.reason.trim() || null,
      tags: normaliseTags(draft.favorite.tags),
    };
    out.favorite_game = favorite;
  }
  if (draft.games.length > 0) out.games_i_like = draft.games.map(gameInput);
  return out.favorite_game || out.games_i_like ? out : null;
}

export function normaliseTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

/** First problem of the draft (the message shown under the Save bar), or null when it can be saved. */
export function validateWidgets(draft: WidgetsDraft): string | null {
  const favorite = draft.favorite;
  if (favorite) {
    if (!favorite.name.trim()) return "Pick a game for your favourite game widget.";
    if (chars(favorite.name.trim()) > GAME_NAME_MAX) return `Game names are up to ${GAME_NAME_MAX} characters.`;
    if (chars(favorite.reason.trim()) > REASON_MAX) return `The reason is up to ${REASON_MAX} characters.`;
    const tags = normaliseTags(favorite.tags);
    if (tags.length > TAGS_MAX) return `Up to ${TAGS_MAX} tags.`;
    if (tags.some(t => chars(t) > TAG_MAX)) return `Tags are up to ${TAG_MAX} characters.`;
  }
  if (draft.games.length > GAMES_MAX) return `Up to ${GAMES_MAX} games.`;
  for (const game of draft.games) {
    if (!game.name.trim()) return "Every game needs a name.";
    if (chars(game.name.trim()) > GAME_NAME_MAX) return `Game names are up to ${GAME_NAME_MAX} characters.`;
  }
  return null;
}

export function sameWidgets(a: WidgetsDraft, b: WidgetsDraft): boolean {
  return JSON.stringify(widgetsToInput(a)) === JSON.stringify(widgetsToInput(b));
}
