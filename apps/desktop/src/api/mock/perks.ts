// Profile perks of docs/api.md ("Profile perks"): banner, pronouns, theme colours, avatar decoration, profile effect, server tag,
// per-server member profiles and the guild tag/theme blocks. Validation mirrors what the server will enforce; ids are checked
// against the open asset set the client ships (src/perks/catalog.ts).

import { BADGES, BIO_MAX, PRONOUNS_MAX, TAG_RE, decorationById, effectById, isThemeColors } from "../../perks/catalog";
import type { Attachment, GuildMember, GuildTag, GuildTheme, ProfileWidgets, User } from "../types";
import { db } from "./db";
import type { MockGuild } from "./db";
import { fail } from "./ops";
import { emit } from "./socket";

const invalid = (field: string, code: string, message: string): never => fail(400, 50035, "Invalid Form Body", { [field]: { code, message } });

export type ResolveAttachment = (id: string | undefined) => Attachment | null;

const text = (value: unknown, field: string, max: number): string | null => {
  if (value === null) return null;
  if (typeof value !== "string") return invalid(field, "BASE_TYPE_STRING", "Not a string.");
  const trimmed = value.trim();
  if (trimmed.length > max) invalid(field, "BASE_TYPE_MAX_LENGTH", `Must be ${max} or fewer in length.`);
  return trimmed === "" ? null : trimmed;
};

const colors = (value: unknown, field: string): [number, number] | null => {
  if (value === null) return null;
  if (!isThemeColors(value)) return invalid(field, "COLOR_TYPE_CONVERT", "Must be two RGB integers.");
  return [value[0], value[1]];
};

const attachmentId = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export const WIDGET_NAME_MAX = 64;
export const WIDGET_REASON_MAX = 190;
export const WIDGET_TAGS_MAX = 5;
export const WIDGET_TAG_MAX = 20;
export const LIKED_GAMES_MAX = 20;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Length in characters (code points), like the server counts them. */
const chars = (value: string): number => [...value].length;

/** An own upload by id, or the id of an image already on the profile (echoed back). */
function widgetImage(user: User, value: unknown, field: string): { image: string | null; image_attachment_id: string | null } {
  if (value === undefined || value === null) return { image: null, image_attachment_id: null };
  if (typeof value !== "string") return invalid(field, "BASE_TYPE_STRING", "Not a string.");
  const pending = db.pending.get(value);
  if (pending) {
    if (pending.owner !== user.id) return invalid(field, "ATTACHMENT_NOT_FOUND", "Unknown attachment.");
    if (!IMAGE_TYPES.has(pending.attachment.content_type ?? "")) return invalid(field, "INVALID_IMAGE", "Must be a PNG, JPEG, GIF or WebP image.");
    return { image: pending.attachment.url, image_attachment_id: value };
  }
  const shown = [user.widgets?.favorite_game, ...(user.widgets?.games_i_like ?? [])].find(game => game?.image_attachment_id === value);
  if (shown?.image) return { image: shown.image, image_attachment_id: value };
  return invalid(field, "ATTACHMENT_NOT_FOUND", "Unknown attachment.");
}

function widgetName(value: unknown, field: string): string {
  if (typeof value !== "string") return invalid(field, "BASE_TYPE_STRING", "Not a string.");
  const name = value.trim();
  if (name === "" || chars(name) > WIDGET_NAME_MAX) invalid(field, "BASE_TYPE_BAD_LENGTH", `Must be between 1 and ${WIDGET_NAME_MAX} characters in length.`);
  return name;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `widgets` of PATCH /users/@me: validates the whole board (same limits and error shape as the other profile fields) and returns the
 * value to store; `null` clears. Nothing is mutated, so a rejected request changes nothing.
 */
export function parseWidgets(user: User, value: unknown): ProfileWidgets | null {
  if (value === null) return null;
  if (!isObject(value)) return invalid("widgets", "BASE_TYPE_OBJECT", "Not an object.");
  if (Object.keys(value).some(key => key !== "favorite_game" && key !== "games_i_like")) invalid("widgets", "UNKNOWN_KEY", "Only favorite_game and games_i_like are allowed.");
  const out: ProfileWidgets = {};
  const favorite = value.favorite_game;
  if (favorite !== undefined && favorite !== null) {
    if (!isObject(favorite)) return invalid("widgets.favorite_game", "BASE_TYPE_OBJECT", "Not an object.");
    const name = widgetName(favorite.name, "widgets.favorite_game.name");
    const reasonField = "widgets.favorite_game.reason";
    const reasonRaw = favorite.reason;
    if (reasonRaw !== undefined && reasonRaw !== null && typeof reasonRaw !== "string") invalid(reasonField, "BASE_TYPE_STRING", "Not a string.");
    const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";
    if (chars(reason) > WIDGET_REASON_MAX) invalid(reasonField, "BASE_TYPE_MAX_LENGTH", `Must be ${WIDGET_REASON_MAX} or fewer in length.`);
    const tagsRaw = favorite.tags ?? [];
    if (!Array.isArray(tagsRaw)) return invalid("widgets.favorite_game.tags", "BASE_TYPE_ARRAY", "Not a list.");
    if (tagsRaw.length > WIDGET_TAGS_MAX) invalid("widgets.favorite_game.tags", "BASE_TYPE_MAX_LENGTH", `Must be ${WIDGET_TAGS_MAX} or fewer.`);
    const tags: string[] = [];
    for (const raw of tagsRaw) {
      const tag = typeof raw === "string" ? raw.trim() : "";
      if (tag === "" || chars(tag) > WIDGET_TAG_MAX) invalid("widgets.favorite_game.tags", "BASE_TYPE_BAD_LENGTH", `Each tag must be between 1 and ${WIDGET_TAG_MAX} characters in length.`);
      if (tags.some(other => other.toLowerCase() === tag.toLowerCase())) invalid("widgets.favorite_game.tags", "DUPLICATE", "Tags must be unique.");
      tags.push(tag);
    }
    const image = widgetImage(user, favorite.image_attachment_id, "widgets.favorite_game.image_attachment_id");
    out.favorite_game = { name, ...image, reason: reason === "" ? null : reason, tags };
  }
  const liked = value.games_i_like;
  if (liked !== undefined && liked !== null) {
    if (!Array.isArray(liked)) return invalid("widgets.games_i_like", "BASE_TYPE_ARRAY", "Not a list.");
    if (liked.length > LIKED_GAMES_MAX) invalid("widgets.games_i_like", "BASE_TYPE_MAX_LENGTH", `Must be ${LIKED_GAMES_MAX} or fewer.`);
    out.games_i_like = liked.map((entry, index) => {
      if (!isObject(entry)) return invalid(`widgets.games_i_like.${index}`, "BASE_TYPE_OBJECT", "Not an object.");
      const name = widgetName(entry.name, `widgets.games_i_like.${index}.name`);
      return { name, ...widgetImage(user, entry.image_attachment_id, `widgets.games_i_like.${index}.image_attachment_id`) };
    });
  }
  return out.favorite_game || out.games_i_like ? out : null;
}

/** The member-profile columns as they appear on `GuildMember` (absent when not set). */
export function memberProfileFields(record: Partial<GuildMember>): Partial<GuildMember> {
  const out: Partial<GuildMember> = {};
  if (record.avatar) out.avatar = record.avatar;
  if (record.banner) out.banner = record.banner;
  if (record.bio) out.bio = record.bio;
  if (record.pronouns) out.pronouns = record.pronouns;
  if (record.theme_colors) out.theme_colors = [...record.theme_colors];
  return out;
}

/** PATCH /users/@me: the perk fields. Called after the core fields; mutates the user. */
export function applyUserPerks(user: User, body: Record<string, unknown>, resolve: ResolveAttachment): void {
  if ("banner_attachment_id" in body) {
    const attachment = body.banner_attachment_id === null ? null : resolve(attachmentId(body.banner_attachment_id));
    user.banner = attachment ? attachment.url : null;
  }
  if ("pronouns" in body) user.pronouns = text(body.pronouns, "pronouns", PRONOUNS_MAX);
  if ("theme_colors" in body) user.theme_colors = colors(body.theme_colors, "theme_colors");
  if ("avatar_decoration" in body) {
    const id = body.avatar_decoration;
    if (id !== null && !(typeof id === "string" && decorationById(id))) invalid("avatar_decoration", "INVALID_DECORATION", "Unknown avatar decoration.");
    user.avatar_decoration = id as string | null;
  }
  if ("profile_effect" in body) {
    const id = body.profile_effect;
    if (id !== null && !(typeof id === "string" && effectById(id))) invalid("profile_effect", "INVALID_EFFECT", "Unknown profile effect.");
    user.profile_effect = id as string | null;
  }
  if ("primary_guild_id" in body) {
    const id = body.primary_guild_id;
    if (id === null) {
      user.primary_guild = null;
    } else {
      const guild = typeof id === "string" ? db.guilds.get(id) : undefined;
      if (!guild || !guild.members.has(user.id)) invalid("primary_guild_id", "NOT_A_MEMBER", "You are not a member of that server.");
      const tag = guild?.guild.tag;
      if (!guild || !tag) return invalid("primary_guild_id", "NO_SERVER_TAG", "That server has no tag.");
      user.primary_guild = { guild_id: guild.guild.id, ...tag };
    }
  }
}

/** PATCH /guilds/{id}/members/@me: per-server profile fields. Returns true when any field was present. */
export function applyOwnMemberPerks(record: Partial<GuildMember>, body: Record<string, unknown>, resolve: ResolveAttachment): boolean {
  let touched = false;
  if ("avatar_attachment_id" in body) {
    touched = true;
    const attachment = body.avatar_attachment_id === null ? null : resolve(attachmentId(body.avatar_attachment_id));
    record.avatar = attachment ? attachment.url : null;
  }
  if ("banner_attachment_id" in body) {
    touched = true;
    const attachment = body.banner_attachment_id === null ? null : resolve(attachmentId(body.banner_attachment_id));
    record.banner = attachment ? attachment.url : null;
  }
  if ("bio" in body) {
    touched = true;
    record.bio = text(body.bio, "bio", BIO_MAX);
  }
  if ("pronouns" in body) {
    touched = true;
    record.pronouns = text(body.pronouns, "pronouns", PRONOUNS_MAX);
  }
  if ("theme_colors" in body) {
    touched = true;
    record.theme_colors = colors(body.theme_colors, "theme_colors");
  }
  return touched;
}

function parseTag(value: unknown): GuildTag | null {
  if (value === null) return null;
  const v = value as Partial<GuildTag> | undefined;
  if (typeof v !== "object" || v === null) return invalid("tag", "BASE_TYPE_OBJECT", "Not an object.");
  if (typeof v.tag !== "string" || !TAG_RE.test(v.tag)) invalid("tag", "TAG_INVALID", "Tags are 1 to 4 letters or numbers.");
  if (typeof v.badge !== "string" || !BADGES.some(b => b.id === v.badge)) invalid("tag", "BADGE_INVALID", "Unknown badge.");
  const ints = [v.color_primary, v.color_secondary];
  if (!ints.every(n => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 0xffffff)) invalid("tag", "COLOR_TYPE_CONVERT", "Colors must be RGB integers.");
  return { tag: v.tag as string, badge: v.badge as string, color_primary: v.color_primary as number, color_secondary: v.color_secondary as number };
}

function parseTheme(value: unknown): GuildTheme | null {
  if (value === null) return null;
  const v = value as Partial<GuildTheme> | undefined;
  if (typeof v !== "object" || v === null) return invalid("theme", "BASE_TYPE_OBJECT", "Not an object.");
  if (v.preset !== null && v.preset !== undefined && (typeof v.preset !== "string" || v.preset.length > 32)) invalid("theme", "PRESET_INVALID", "Preset must be a short id or null.");
  const ints = [v.primary, v.accent];
  if (!ints.every(n => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 0xffffff)) invalid("theme", "COLOR_TYPE_CONVERT", "Colors must be RGB integers.");
  return { preset: v.preset ?? null, primary: v.primary as number, accent: v.accent as number };
}

/** PATCH /guilds/{id}: the tag and theme blocks (MANAGE_GUILD is checked by the route). */
export function applyGuildPerks(guild: MockGuild, body: Record<string, unknown>): void {
  if ("tag" in body) {
    const tag = parseTag(body.tag);
    guild.guild.tag = tag;
    // Holders wear the guild's tag as it is now; removing the tag takes it off everyone.
    const holders = [...db.accounts.values()].filter(a => a.user.primary_guild?.guild_id === guild.guild.id);
    for (const account of holders) {
      account.user.primary_guild = tag ? { guild_id: guild.guild.id, ...tag } : null;
      emit(guild.members.keys(), "USER_UPDATE", { ...account.user });
    }
  }
  if ("theme" in body) guild.guild.theme = parseTheme(body.theme);
}

/** A member who leaves, is kicked or banned stops wearing that server's tag. */
export function dropTagOnLeave(guild: MockGuild, userId: string): void {
  const user = db.accounts.get(userId)?.user;
  if (!user || user.primary_guild?.guild_id !== guild.guild.id) return;
  user.primary_guild = null;
  emit([userId, ...guild.members.keys()], "USER_UPDATE", { ...user });
}
