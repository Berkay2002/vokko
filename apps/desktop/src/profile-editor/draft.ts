import type { GuildMember, Snowflake, User } from "../api/types";
import type { ProfileLook } from "../perks/profile";
import { chars, sameWidgets, validateWidgets, widgetsFromUser, widgetsToInput, type WidgetsDraft } from "./widgets";

/** Which profile is being edited: the global one, or the per-server override of one guild. */
export type Scope = { kind: "main" } | { kind: "guild"; guildId: Snowflake };

export const MAIN_SCOPE: Scope = { kind: "main" };

/** A staged image: undefined = unchanged, null = removed, object = uploaded and waiting for Save. */
export type Staged = undefined | null | { id: string; url: string };

export type ThemeColors = [number, number] | null;

/** User fields owned by pickers that plug in through the tile registry; the draft carries them untouched until a picker sets them. */
export const EXTRA_FIELDS = ["nameplate", "display_name_styles", "profile_frame"] as const;

export interface ProfileDraft {
  /** Display name (main profile: global_name; server profile: the nickname). */
  name: string;
  pronouns: string;
  bio: string;
  bannerColor: string | null;
  theme: ThemeColors;
  decoration: string | null;
  effect: string | null;
  tagGuild: Snowflake | null;
  avatar: Staged;
  banner: Staged;
  widgets: WidgetsDraft;
  extra: Record<string, unknown>;
}

const sameTheme = (a: ThemeColors, b: ThemeColors) => (!a && !b) || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function initDraft(user: User, member: GuildMember | null | undefined, scope: Scope): ProfileDraft {
  const extra: Record<string, unknown> = {};
  for (const field of EXTRA_FIELDS) extra[field] = (user as unknown as Record<string, unknown>)[field] ?? null;
  if (scope.kind === "guild") {
    return {
      name: member?.nick ?? "",
      pronouns: member?.pronouns ?? "",
      bio: member?.bio ?? "",
      bannerColor: user.banner_color,
      theme: member?.theme_colors ?? null,
      decoration: user.avatar_decoration ?? null,
      effect: user.profile_effect ?? null,
      tagGuild: user.primary_guild?.guild_id ?? null,
      avatar: undefined,
      banner: undefined,
      widgets: widgetsFromUser(user.widgets),
      extra,
    };
  }
  return {
    name: user.global_name ?? "",
    pronouns: user.pronouns ?? "",
    bio: user.bio ?? "",
    bannerColor: user.banner_color,
    theme: user.theme_colors ?? null,
    decoration: user.avatar_decoration ?? null,
    effect: user.profile_effect ?? null,
    tagGuild: user.primary_guild?.guild_id ?? null,
    avatar: undefined,
    banner: undefined,
    widgets: widgetsFromUser(user.widgets),
    extra,
  };
}

/** Names of the draft fields that differ from `initial` for this scope. */
export function changedFields(draft: ProfileDraft, initial: ProfileDraft, scope: Scope): string[] {
  const out: string[] = [];
  if (draft.name.trim() !== initial.name) out.push("name");
  if (draft.pronouns.trim() !== initial.pronouns) out.push("pronouns");
  if (draft.bio.trim() !== initial.bio) out.push("bio");
  if (!sameTheme(draft.theme, initial.theme)) out.push("theme");
  if (draft.avatar !== undefined) out.push("avatar");
  if (draft.banner !== undefined) out.push("banner");
  if (scope.kind === "main") {
    if ((draft.bannerColor ?? null) !== (initial.bannerColor ?? null)) out.push("bannerColor");
    if (draft.decoration !== initial.decoration) out.push("decoration");
    if (draft.effect !== initial.effect) out.push("effect");
    if (draft.tagGuild !== initial.tagGuild) out.push("tagGuild");
    if (!sameWidgets(draft.widgets, initial.widgets)) out.push("widgets");
    for (const field of EXTRA_FIELDS) if (!sameJson(draft.extra[field], initial.extra[field])) out.push(`extra:${field}`);
  }
  return out;
}

export const isDirty = (draft: ProfileDraft, initial: ProfileDraft, scope: Scope): boolean => changedFields(draft, initial, scope).length > 0;

/** First reason the draft cannot be saved, or null. */
export function validateDraft(draft: ProfileDraft, scope: Scope): string | null {
  if (chars(draft.name.trim()) > 32) return "Display names are up to 32 characters.";
  return scope.kind === "main" ? validateWidgets(draft.widgets) : null;
}

/** The request body for `PATCH /users/@me` (main) or `PATCH /guilds/:id/members/@me` (server profile): changed fields only. */
export function toPatch(draft: ProfileDraft, initial: ProfileDraft, scope: Scope): Record<string, unknown> {
  const changed = new Set(changedFields(draft, initial, scope));
  const patch: Record<string, unknown> = {};
  if (changed.has("name")) patch[scope.kind === "guild" ? "nick" : "global_name"] = draft.name.trim() || null;
  if (changed.has("pronouns")) patch.pronouns = draft.pronouns.trim() || null;
  if (changed.has("bio")) patch.bio = draft.bio.trim() || null;
  if (changed.has("theme")) patch.theme_colors = draft.theme;
  if (changed.has("avatar")) patch.avatar_attachment_id = draft.avatar?.id ?? null;
  if (changed.has("banner")) patch.banner_attachment_id = draft.banner?.id ?? null;
  if (scope.kind === "main") {
    if (changed.has("bannerColor")) patch.banner_color = draft.bannerColor;
    if (changed.has("decoration")) patch.avatar_decoration = draft.decoration;
    if (changed.has("effect")) patch.profile_effect = draft.effect;
    if (changed.has("tagGuild")) patch.primary_guild_id = draft.tagGuild;
    if (changed.has("widgets")) patch.widgets = widgetsToInput(draft.widgets);
    for (const field of EXTRA_FIELDS) if (changed.has(`extra:${field}`)) patch[field] = draft.extra[field] ?? null;
  }
  return patch;
}

/** The profile as the live card shows it: staged values over the saved ones; a server profile falls back to the main profile per field. */
export function lookOf(user: User, member: GuildMember | null | undefined, draft: ProfileDraft, scope: Scope): ProfileLook {
  const guild = scope.kind === "guild";
  const avatar = draft.avatar === undefined ? (guild ? member?.avatar || user.avatar : user.avatar) : draft.avatar?.url ?? (guild ? user.avatar : null);
  const banner = draft.banner === undefined ? (guild ? member?.banner || user.banner || null : user.banner ?? null) : draft.banner?.url ?? (guild ? user.banner ?? null : null);
  return {
    avatar,
    banner,
    bannerColor: draft.bannerColor,
    bio: draft.bio.trim() || (guild ? user.bio : null),
    pronouns: draft.pronouns.trim() || (guild ? user.pronouns ?? null : null),
    themeColors: draft.theme ?? (guild ? user.theme_colors ?? null : null),
    decoration: draft.decoration,
    effect: draft.effect,
    frame: typeof draft.extra.profile_frame === "string" ? draft.extra.profile_frame : null,
  };
}
