// Profile perks of docs/api.md ("Profile perks"): banner, pronouns, theme colours, avatar decoration, profile effect, server tag,
// per-server member profiles and the guild tag/theme blocks. Validation mirrors what the server will enforce; ids are checked
// against the open asset set the client ships (src/perks/catalog.ts).

import { BADGES, BIO_MAX, PRONOUNS_MAX, TAG_RE, decorationById, effectById, isThemeColors } from "../../perks/catalog";
import type { Attachment, GuildMember, GuildTag, GuildTheme, User } from "../types";
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
