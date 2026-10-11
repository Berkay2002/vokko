// Custom guild emoji in the mock: every route of docs/api.md "Custom emoji" with the server's limits, error codes and
// GUILD_EMOJIS_UPDATE fan-out, plus the reaction rule (membership, role restriction, USE_EXTERNAL_EMOJIS).

import { Perm, hasBit } from "../permissions";
import type { GuildEmoji, ReactionEmoji } from "../types";
import { channelPermsOf } from "./access";
import { db, nextId, userOf, type MockChannel } from "./db";
import { fail, guildAudience, requireGuildMember, requireGuildPerm } from "./ops";
import { ID, route, str } from "./router";
import { emit } from "./socket";

export interface MockEmoji {
  id: string;
  guild_id: string;
  name: string;
  roles: string[];
  animated: boolean;
  url: string;
  uploader_id: string | null;
}

export const EMOJI_LIMIT_PER_KIND = 250;
export const EMOJI_MAX_BYTES = 256 * 1024;
const NAME_RE = /^[A-Za-z0-9_]{2,32}$/;

export function emojiFor(e: MockEmoji, withUser: boolean): GuildEmoji {
  const out: GuildEmoji = { id: e.id, name: e.name, roles: [...e.roles], require_colons: true, managed: false, animated: e.animated, available: true, url: e.url };
  if (withUser && e.uploader_id && db.accounts.has(e.uploader_id)) out.user = userOf(e.uploader_id);
  return out;
}

export function guildEmojis(guildId: string, withUser = false): GuildEmoji[] {
  return [...db.emojis.values()].filter(e => e.guild_id === guildId).map(e => emojiFor(e, withUser));
}

function broadcast(guildId: string): void {
  emit(guildAudience(guildId), "GUILD_EMOJIS_UPDATE", { guild_id: guildId, emojis: guildEmojis(guildId) });
}

function invalid(field: string, message: string): never {
  fail(400, 50035, "Invalid Form Body", { [field]: { _errors: [{ code: "INVALID", message }] } });
}

function checkName(value: unknown): string {
  const name = str(value) ?? "";
  if (!NAME_RE.test(name)) invalid("name", "Must be 2-32 characters of letters, digits and underscores.");
  return name;
}

function checkRoles(guildId: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid("roles", "Must be a list of role ids.");
  const roles = db.guilds.get(guildId)?.guild.roles ?? [];
  const ids = [...new Set(value.map(v => String(v)))];
  if (ids.some(id => id === guildId || !roles.some(r => r.id === id))) invalid("roles", "Unknown role.");
  return ids;
}

function requireEmoji(guildId: string, emojiId: string): MockEmoji {
  const emoji = db.emojis.get(emojiId);
  if (!emoji || emoji.guild_id !== guildId) fail(404, 10014, "Unknown Emoji");
  return emoji;
}

/** Adds an emoji directly (seed); no checks. */
export function addEmoji(init: Omit<MockEmoji, "id"> & { id?: string }): MockEmoji {
  const emoji: MockEmoji = { ...init, id: init.id ?? nextId() };
  db.emojis.set(emoji.id, emoji);
  return emoji;
}

/**
 * The reaction emoji to store for a PUT: unicode passes through; a custom one must exist (400 10014), the viewer must be a member of its
 * guild holding one of its roles if it has any, and another guild's emoji in a guild channel needs USE_EXTERNAL_EMOJIS (403 50013).
 */
export function resolveReactionEmoji(channel: MockChannel, viewerId: string, raw: ReactionEmoji): ReactionEmoji {
  if (raw.id === null) return raw;
  const emoji = db.emojis.get(raw.id);
  if (!emoji) fail(400, 10014, "Unknown Emoji");
  const member = db.guilds.get(emoji.guild_id)?.members.get(viewerId);
  if (!member || (emoji.roles.length > 0 && !emoji.roles.some(r => member.roles.includes(r)))) fail(403, 50013, "Missing Permissions");
  if (channel.guild_id && channel.guild_id !== emoji.guild_id && !hasBit(channelPermsOf(channel, viewerId), Perm.USE_EXTERNAL_EMOJIS)) fail(403, 50013, "Missing Permissions");
  return { id: emoji.id, name: emoji.name, animated: emoji.animated };
}

/** A custom emoji is one reaction by id whatever name a request uses; unicode compares by name. */
export const sameReactionEmoji = (a: ReactionEmoji, b: ReactionEmoji): boolean => (a.id !== null || b.id !== null ? a.id === b.id : a.name === b.name);

route("GET", `/guilds/${ID}/emojis`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  return guildEmojis(guildId, true);
});

route("GET", `/guilds/${ID}/emojis/${ID}`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  return emojiFor(requireEmoji(guildId, params[1] ?? ""), true);
});

route("POST", `/guilds/${ID}/emojis`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  requireGuildPerm(guildId, viewer.user.id, Perm.MANAGE_GUILD_EXPRESSIONS);
  const name = checkName(body.name);
  const roles = checkRoles(guildId, body.roles);
  const attachmentId = str(body.image_attachment_id);
  const pending = attachmentId ? db.pending.get(attachmentId) : undefined;
  if (!attachmentId || !pending || pending.owner !== viewer.user.id) invalid("image_attachment_id", "Unknown attachment.");
  const type = pending.attachment.content_type ?? "";
  if (!["image/png", "image/gif", "image/webp"].includes(type)) invalid("image_attachment_id", "Must be a PNG, GIF or WebP image.");
  if (pending.attachment.size > EMOJI_MAX_BYTES) invalid("image_attachment_id", "The image is too large (256 KiB at most).");
  // The mock cannot read the bytes: only GIF counts as animated here, while the server also treats a WebP with the VP8X animation flag as animated. e2e tests must not rely on animated WebP.
  const animated = type === "image/gif";
  const sameKind = [...db.emojis.values()].filter(e => e.guild_id === guildId && e.animated === animated).length;
  if (sameKind >= EMOJI_LIMIT_PER_KIND) fail(400, 30008, "Maximum number of emojis reached (250)");
  db.pending.delete(attachmentId);
  const emoji = addEmoji({ guild_id: guildId, name, roles, animated, url: pending.attachment.url, uploader_id: viewer.user.id });
  broadcast(guildId);
  return emojiFor(emoji, true);
});

route("PATCH", `/guilds/${ID}/emojis/${ID}`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  requireGuildPerm(guildId, viewer.user.id, Perm.MANAGE_GUILD_EXPRESSIONS);
  const emoji = requireEmoji(guildId, params[1] ?? "");
  const name = "name" in body ? checkName(body.name) : emoji.name;
  const roles = "roles" in body ? checkRoles(guildId, body.roles) : emoji.roles;
  emoji.name = name;
  emoji.roles = roles;
  broadcast(guildId);
  return emojiFor(emoji, true);
});

route("DELETE", `/guilds/${ID}/emojis/${ID}`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildPerm(guildId, viewer.user.id, Perm.MANAGE_GUILD_EXPRESSIONS);
  const emoji = requireEmoji(guildId, params[1] ?? "");
  db.emojis.delete(emoji.id);
  broadcast(guildId);
  return undefined;
});

// ---- seed images: Vokko's own drawings (SVG), never Discord assets ----

function svg(body: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`)}`;
}

export const SEED_EMOJI_IMAGES = {
  vokko_smile: svg('<circle cx="32" cy="32" r="28" fill="#5b6cf0"/><circle cx="23" cy="26" r="4" fill="#fff"/><circle cx="41" cy="26" r="4" fill="#fff"/><path d="M20 40 Q32 52 44 40" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round"/>'),
  ship_it: svg('<rect x="8" y="8" width="48" height="48" rx="12" fill="#3ba55d"/><path d="M18 33 L28 43 L47 22" stroke="#fff" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
  party_blob: svg(
    '<circle cx="32" cy="34" r="24" fill="#f4a259"><animate attributeName="r" values="24;20;24" dur="0.8s" repeatCount="indefinite"/></circle><circle cx="25" cy="30" r="3" fill="#222"/><circle cx="39" cy="30" r="3" fill="#222"/><path d="M26 40 Q32 46 38 40" stroke="#222" stroke-width="3" fill="none"/>',
  ),
  mods_only: svg('<path d="M32 6 L54 14 V32 C54 46 44 54 32 58 C20 54 10 46 10 32 V14 Z" fill="#d1495b"/><path d="M24 32 L30 38 L41 26" stroke="#fff" stroke-width="5" fill="none"/>'),
} as const;
