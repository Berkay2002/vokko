// Mock of GET/PATCH /users/@me/settings, USER_SETTINGS_UPDATE and GET /users/@me/export (docs/api.md "User settings").

import { ChannelType, RelationshipType, type ApiError, type UserDataExport, type UserSettings, type UserSettingsData } from "../types";
import { ApiRequestError, RateLimitedError } from "../errors";
import { db, userOf } from "./db";
import { fail } from "./ops";
import { ID, route } from "./router";
import { emit } from "./socket";
import { relationship, relationshipsFor } from "./views";

export const SETTINGS_MAX_BYTES = 64 * 1024;
export const EXPORT_MAX_MESSAGES = 20_000;
export const EXPORT_INTERVAL_MS = 24 * 3600 * 1000;

const blobs = new Map<string, UserSettings>();
const lastExport = new Map<string, number>();

/** One allow-list entry, as `vokko_protocol::api::user_settings::Kind`. */
type Kind =
  | { kind: "bool" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "int"; min: number; max: number }
  | { kind: "text"; maxChars: number }
  | { kind: "stringList"; maxItems: number; maxChars: number }
  | { kind: "keybinds" };

const BOOL: Kind = { kind: "bool" };
const oneOf = (...values: string[]): Kind => ({ kind: "enum", values });
export const MAX_KEYBINDS = 512;

/** Port of `user_settings::KEYS` (crates/protocol/src/api.rs); keep the two in step. */
export const SETTINGS_KEYS: ReadonlyMap<string, Kind> = new Map<string, Kind>([
  ["theme", { kind: "text", maxChars: 32 }],
  ["message_display", oneOf("cozy", "compact")],
  ["density", oneOf("compact", "default", "cozy")],
  ["message_spacing", oneOf("compact", "balanced", "roomy")],
  ["message_group_gap", { kind: "int", min: 0, max: 24 }],
  ["show_compact_avatars", BOOL],
  ["inline_attachment_media", BOOL],
  ["inline_embed_media", BOOL],
  ["show_embeds", BOOL],
  ["show_reactions", BOOL],
  ["convert_emoticons", BOOL],
  ["emoji_autocomplete", BOOL],
  ["sticker_suggestions", BOOL],
  ["sticker_autocomplete", BOOL],
  ["preview_markdown", BOOL],
  ["spoiler_content", oneOf("click", "always", "moderated")],
  ["thread_split_view", BOOL],
  ["locale", { kind: "text", maxChars: 16 }],
  ["time_format", oneOf("auto", "12", "24")],
  ["desktop_notifications", BOOL],
  ["notification_sounds", BOOL],
  ["sound_current_channel", BOOL],
  ["unread_badge", BOOL],
  ["taskbar_flash", BOOL],
  ["friends_online_alerts", BOOL],
  ["reaction_notifications", oneOf("all", "dm", "never")],
  ["disabled_sounds", { kind: "stringList", maxItems: 32, maxChars: 32 }],
  ["keybinds", { kind: "keybinds" }],
  ["emoji_favorites", { kind: "stringList", maxItems: 100, maxChars: 64 }],
  ["sticker_favorites", { kind: "stringList", maxItems: 100, maxChars: 32 }],
  ["streamer_mode", BOOL],
  ["streamer_auto_enable", BOOL],
  ["streamer_hide_personal", BOOL],
  ["streamer_hide_invites", BOOL],
  ["streamer_disable_sounds", BOOL],
  ["streamer_disable_notifications", BOOL],
  ["streamer_hide_window", BOOL],
  ["developer_mode", BOOL],
  ["dms_from_server_members", BOOL],
  ["message_requests", BOOL],
  ["friend_requests_everyone", BOOL],
  ["friend_requests_mutual_friends", BOOL],
  ["friend_requests_mutual_guilds", BOOL],
  ["share_activity", BOOL],
  ["share_spotify", BOOL],
  ["share_typing", BOOL],
  ["share_mutuals", BOOL],
]);

const chars = (text: string): number => [...text].length;
const shortText = (value: unknown, maxChars: number): boolean => typeof value === "string" && value.length > 0 && chars(value) <= maxChars;

/** `user_settings::validate` for one value. */
export function validSetting(kind: Kind, value: unknown): boolean {
  switch (kind.kind) {
    case "bool":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && kind.values.includes(value);
    case "int":
      return typeof value === "number" && Number.isInteger(value) && value >= kind.min && value <= kind.max;
    case "text":
      return shortText(value, kind.maxChars);
    case "stringList":
      return Array.isArray(value) && value.length <= kind.maxItems && value.every(item => shortText(item, kind.maxChars)) && new Set(value).size === value.length;
    case "keybinds":
      return (
        Array.isArray(value) &&
        value.length <= MAX_KEYBINDS &&
        value.every(item => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return false;
          const bind = item as Record<string, unknown>;
          return (
            Object.keys(bind).every(field => field === "action" || field === "keys" || field === "global") &&
            shortText(bind.action, 64) &&
            shortText(bind.keys, 64) &&
            (bind.global === undefined || typeof bind.global === "boolean")
          );
        })
      );
  }
}

export function settingsOf(userId: string): UserSettings {
  return structuredClone(blobs.get(userId) ?? { version: 0, settings: {} });
}

/** PATCH semantics shared by the route and the "other device" test hook. */
export function patchSettings(userId: string, version: number, patch: UserSettingsData, opts: { silent?: boolean } = {}): UserSettings {
  const errors: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const kind = SETTINGS_KEYS.get(key);
    if (!kind) errors[key] = { _errors: [{ code: "INVALID", message: "Unknown setting." }] };
    else if (value !== null && !validSetting(kind, value)) errors[key] = { _errors: [{ code: "INVALID", message: "Invalid value for this setting." }] };
  }
  if (Object.keys(errors).length > 0) fail(400, 50035, "Invalid Form Body", { settings: errors });
  const current = settingsOf(userId);
  // 409 body = UserSettingsConflict: the error fields plus the current blob, flattened.
  if (version !== current.version) throw new ApiRequestError(409, { code: 40090, message: "Settings version conflict", ...current } as ApiError);
  const next = { ...current.settings };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  if (JSON.stringify(next).length > SETTINGS_MAX_BYTES) fail(400, 50035, "Invalid Form Body", { settings: { _errors: [{ code: "INVALID", message: "Settings must be at most 64 KiB." }] } });
  const saved: UserSettings = { version: current.version + 1, settings: next };
  blobs.set(userId, saved);
  if (!opts.silent) emit([userId], "USER_SETTINGS_UPDATE", structuredClone(saved));
  return structuredClone(saved);
}

/** A boolean privacy key of `userId`, `true` when unset (all of them default to allowing). */
export function privacyAllows(userId: string, key: "dms_from_server_members" | "friend_requests_everyone" | "friend_requests_mutual_friends" | "friend_requests_mutual_guilds"): boolean {
  return blobs.get(userId)?.settings[key] !== false;
}

const sharesGuild = (a: string, b: string): boolean => [...db.guilds.values()].some(g => g.members.has(a) && g.members.has(b));
const isFriend = (a: string, b: string): boolean => relationship(a, b)?.type === RelationshipType.Friend;

/** Per-user guild ids whose members may not DM that user (GET/PATCH /users/@me/guilds/{id}/privacy). */
const restrictedGuilds = new Map<string, Set<string>>();
/** Per-user guild ids where that user appears offline (the mock only stores it; presence is not filtered). */
const offlineGuilds = new Map<string, Set<string>>();

const guildPrivacy = (userId: string, guildId: string) => ({
  direct_messages: !restrictedGuilds.get(userId)?.has(guildId),
  appear_offline: !!offlineGuilds.get(userId)?.has(guildId),
});

function toggle(sets: Map<string, Set<string>>, userId: string, guildId: string, on: boolean): void {
  const set = sets.get(userId) ?? new Set<string>();
  if (on) set.add(guildId);
  else set.delete(guildId);
  sets.set(userId, set);
}

/**
 * 403 50007 unless `sender` is a friend of `target`, or `target` accepts DMs from server members (global setting, default on)
 * and they share a guild `target` has not restricted. Group DMs are not checked.
 */
export function assertCanOpenDm(sender: string, target: string): void {
  if (isFriend(sender, target)) return;
  const restricted = restrictedGuilds.get(target);
  const open = privacyAllows(target, "dms_from_server_members") && [...db.guilds.values()].some(g => g.members.has(sender) && g.members.has(target) && !restricted?.has(g.guild.id));
  if (!open) fail(403, 50007, "Cannot send messages to this user");
}

/** 403 50007 when `userId` may not write (or react) in the 1:1 DM `channel`: a block either way, or the other side's DM privacy. */
export function assertDmOpen(channel: { type: ChannelType; participant_ids?: string[] }, userId: string): void {
  if (channel.type !== ChannelType.DM) return;
  const other = channel.participant_ids?.find(id => id !== userId);
  if (!other) return;
  if (relationship(userId, other)?.type === RelationshipType.Blocked || relationship(other, userId)?.type === RelationshipType.Blocked) fail(403, 50007, "Cannot send messages to this user");
  assertCanOpenDm(userId, other);
}

/** 403 80000 unless one of `target`'s friend request sources covers `sender`. */
export function assertAcceptsFriendRequest(sender: string, target: string): void {
  if (privacyAllows(target, "friend_requests_everyone")) return;
  if (privacyAllows(target, "friend_requests_mutual_friends")) {
    const friends = (id: string) => relationshipsFor(id).filter(r => r.type === RelationshipType.Friend).map(r => r.id);
    const mine = new Set(friends(target));
    if (friends(sender).some(id => mine.has(id))) return;
  }
  if (privacyAllows(target, "friend_requests_mutual_guilds") && sharesGuild(sender, target)) return;
  fail(403, 80000, "Incoming friend requests disabled");
}

route("GET", "/users/@me/settings", ({ viewer }) => settingsOf(viewer.user.id));

route("PATCH", "/users/@me/settings", ({ viewer, body }) => {
  const version = typeof body.version === "number" ? body.version : -1;
  const patch = body.settings && typeof body.settings === "object" && !Array.isArray(body.settings) ? (body.settings as UserSettingsData) : null;
  if (!patch) fail(400, 50035, "Invalid Form Body", { settings: { _errors: [{ code: "INVALID", message: "Expected an object." }] } });
  return patchSettings(viewer.user.id, version, patch);
});

function memberGuild(guildId: string, userId: string): string {
  if (!db.guilds.get(guildId)?.members.has(userId)) fail(404, 10004, "Unknown Guild");
  return guildId;
}

route("GET", `/users/@me/guilds/${ID}/privacy`, ({ viewer, params }) => {
  const guildId = memberGuild(params[0] ?? "", viewer.user.id);
  return guildPrivacy(viewer.user.id, guildId);
});

route("PATCH", `/users/@me/guilds/${ID}/privacy`, ({ viewer, params, body }) => {
  for (const key of ["direct_messages", "appear_offline"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") fail(400, 50035, "Invalid Form Body", { [key]: { _errors: [{ code: "BASE_TYPE_BOOLEAN", message: "Expected a boolean." }] } });
  }
  const guildId = memberGuild(params[0] ?? "", viewer.user.id);
  if (typeof body.direct_messages === "boolean") toggle(restrictedGuilds, viewer.user.id, guildId, !body.direct_messages);
  if (typeof body.appear_offline === "boolean") toggle(offlineGuilds, viewer.user.id, guildId, body.appear_offline);
  return guildPrivacy(viewer.user.id, guildId);
});

route("GET", "/users/@me/export", ({ viewer }) => {
  const id = viewer.user.id;
  const last = lastExport.get(id);
  if (last !== undefined && Date.now() - last < EXPORT_INTERVAL_MS) throw new RateLimitedError((EXPORT_INTERVAL_MS - (Date.now() - last)) / 1000, false);
  lastExport.set(id, Date.now());
  const guilds = [...db.guilds.values()].filter(g => g.members.has(id));
  const messages = [...db.messages.values()].flat().filter(m => m.author_id === id).sort((a, b) => (a.id < b.id ? 1 : -1));
  const channelIds = new Set([...messages.map(m => m.channel_id), ...[...db.channels.values()].filter(c => c.participant_ids?.includes(id) && !c.hidden_for?.has(id)).map(c => c.id)]);
  const result: UserDataExport = {
    exported_at: new Date().toISOString(),
    user: userOf(id),
    settings: settingsOf(id),
    relationships: relationshipsFor(id),
    guilds: guilds.map(g => ({ id: g.guild.id, name: g.guild.name, nick: g.members.get(id)?.nick ?? null, joined_at: g.members.get(id)?.joined_at ?? new Date(0).toISOString() })),
    channels: [...channelIds].flatMap(cid => {
      const c = db.channels.get(cid);
      return c ? [{ id: c.id, type: c.type, guild_id: c.guild_id ?? null, name: c.type === ChannelType.DM ? null : (c.name ?? null), recipient_ids: (c.participant_ids ?? []).filter(p => p !== id) }] : [];
    }),
    messages: messages.slice(0, EXPORT_MAX_MESSAGES).map(m => ({ id: m.id, channel_id: m.channel_id, content: m.content, timestamp: m.timestamp, edited_timestamp: m.edited_timestamp, attachments: m.attachments.map(a => a.filename) })),
    messages_truncated: messages.length > EXPORT_MAX_MESSAGES,
    dm_restricted_guild_ids: [...(restrictedGuilds.get(id) ?? [])].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)),
  };
  return result;
});
