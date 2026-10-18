// Mock of the "Stickers, GIFs, forward, bookmarks, reminders" routes of docs/api.md: same permissions, limits, status and error codes,
// and the same gateway events as the server. The GIF provider is generated placeholder art (see gifs.ts), nothing leaves the machine.

import { MessageType, StickerFormat, type Bookmark, type Gif, type GifPage, type Message, type MessageSnapshot, type Reminder, type Sticker, type StickerItem } from "../types";
import { Perm, hasBit } from "../permissions";
import { channelPermsOf, guildPermsOf } from "./access";
import { db, nextId, sortedMessages, userOf, type MockChannel, type MockMessage, type MockReminder } from "./db";
import { gifPage, mockCategories, trendingLabel } from "./gifs";
import { canAccess, fail, guildAudience, pendingAttachment, requireChannel, requireGuildMember, requireMessage } from "./ops";
import { ID, route, str } from "./router";
import { emit } from "./socket";
import { messageFor } from "./views";
import { isPoll } from "./pollData";

export const MAX_STICKERS_PER_GUILD = 60;
export const MAX_STICKERS_PER_MESSAGE = 3;
export const MAX_STICKER_BYTES = 512 * 1024;
export const MAX_STICKER_PX = 512;
export const MAX_BOOKMARKS = 250;
export const MAX_PENDING_REMINDERS = 50;
export const MAX_FAVORITE_GIFS = 500;
export const MAX_REMIND_AHEAD_MS = 366 * 24 * 3600 * 1000;

const invalid = (field: string, message: string, code = "INVALID"): never => fail(400, 50035, "Invalid Form Body", { [field]: { code, message } });
const bodyError = (field: string, message: string): never => invalid(field, message, "BASE_TYPE_BAD_LENGTH");

// ---- stickers ----

const STICKER_TYPES: Record<string, StickerFormat> = { "image/png": StickerFormat.PNG, "image/apng": StickerFormat.APNG, "image/gif": StickerFormat.GIF, "image/webp": StickerFormat.WebP };

export const stickersOf = (guildId: string): Sticker[] => db.stickers.get(guildId) ?? [];

function emitStickers(guildId: string): void {
  emit(guildAudience(guildId), "GUILD_STICKERS_UPDATE", { guild_id: guildId, stickers: stickersOf(guildId).map(s => ({ ...s })) });
}

/** MANAGE_GUILD_EXPRESSIONS manages everything, CREATE_GUILD_EXPRESSIONS only the stickers the member uploaded themselves. */
function requireStickerPerm(guildId: string, viewerId: string, sticker: Sticker | null): void {
  const bits = guildPermsOf(guildId, viewerId);
  if (hasBit(bits, Perm.MANAGE_GUILD_EXPRESSIONS)) return;
  const own = sticker ? sticker.user?.id === viewerId : true;
  if (hasBit(bits, Perm.CREATE_GUILD_EXPRESSIONS) && own) return;
  fail(403, 50013, "Missing Permissions");
}

function stickerFields(body: Record<string, unknown>, partial: boolean): { name?: string; description?: string | null; tags?: string } {
  const out: { name?: string; description?: string | null; tags?: string } = {};
  if (!partial || "name" in body) {
    const name = (str(body.name) ?? "").trim();
    if (name.length < 2 || name.length > 30) bodyError("name", "Must be between 2 and 30 in length.");
    out.name = name;
  }
  if ("description" in body) {
    const description = body.description === null ? "" : (str(body.description) ?? "").trim();
    if (description.length > 100) bodyError("description", "Must be 100 or fewer in length.");
    out.description = description === "" ? null : description;
  }
  if (!partial || "tags" in body) {
    const tags = (str(body.tags) ?? "").trim();
    if (tags.length < 2 || tags.length > 200) bodyError("tags", "Must be between 2 and 200 in length.");
    out.tags = tags;
  }
  return out;
}

route("GET", `/guilds/${ID}/stickers`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  return stickersOf(guildId);
});

route("GET", `/guilds/${ID}/stickers/${ID}`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  const sticker = stickersOf(guildId).find(s => s.id === params[1]);
  if (!sticker) fail(404, 10060, "Unknown Sticker");
  return sticker;
});

route("POST", `/guilds/${ID}/stickers`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  requireStickerPerm(guildId, viewer.user.id, null);
  const fields = stickerFields(body, false);
  const attachment = pendingAttachment(str(body.attachment_id), viewer.user.id);
  if (!attachment) return invalid("attachment_id", "This field is required", "BASE_TYPE_REQUIRED");
  const format = STICKER_TYPES[attachment.content_type ?? ""];
  if (format === undefined) return invalid("file", "Stickers must be PNG, APNG, GIF or WebP.", "INVALID_FORMAT");
  if (attachment.size > MAX_STICKER_BYTES) return invalid("file", "Stickers can be at most 512 KiB.", "FILE_SIZE_TOO_LARGE");
  if ((attachment.width ?? 0) > MAX_STICKER_PX || (attachment.height ?? 0) > MAX_STICKER_PX) return invalid("file", "Stickers can be at most 512x512 pixels.", "IMAGE_DIMENSIONS");
  const list = db.stickers.get(guildId) ?? [];
  if (list.length >= MAX_STICKERS_PER_GUILD) fail(400, 30039, `Maximum number of stickers reached (${MAX_STICKERS_PER_GUILD})`);
  const sticker: Sticker = {
    id: nextId(),
    guild_id: guildId,
    name: fields.name ?? "",
    description: fields.description ?? null,
    tags: fields.tags ?? "",
    format_type: format,
    url: attachment.url,
    available: true,
    user: userOf(viewer.user.id),
  };
  db.stickers.set(guildId, [...list, sticker]);
  db.pending.delete(attachment.id);
  emitStickers(guildId);
  return sticker;
});

route("PATCH", `/guilds/${ID}/stickers/${ID}`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  const sticker = stickersOf(guildId).find(s => s.id === params[1]);
  if (!sticker) fail(404, 10060, "Unknown Sticker");
  requireStickerPerm(guildId, viewer.user.id, sticker);
  const fields = stickerFields(body, true);
  if (fields.name !== undefined) sticker.name = fields.name;
  if (fields.description !== undefined) sticker.description = fields.description;
  if (fields.tags !== undefined) sticker.tags = fields.tags;
  emitStickers(guildId);
  return sticker;
});

route("DELETE", `/guilds/${ID}/stickers/${ID}`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  const sticker = stickersOf(guildId).find(s => s.id === params[1]);
  if (!sticker) fail(404, 10060, "Unknown Sticker");
  requireStickerPerm(guildId, viewer.user.id, sticker);
  db.stickers.set(guildId, stickersOf(guildId).filter(s => s.id !== sticker.id));
  emitStickers(guildId);
  return undefined;
});

/** `sticker_ids` of a message create → the copies stored on the message. Own guild: always; another guild: member + USE_EXTERNAL_STICKERS (DMs: always). */
export function resolveStickers(channel: MockChannel, viewerId: string, raw: unknown): StickerItem[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some(v => typeof v !== "string")) return invalid("sticker_ids", "Must be a list of sticker ids.", "BASE_TYPE_BAD_FORMAT");
  const ids = [...new Set(raw as string[])];
  if (ids.length > MAX_STICKERS_PER_MESSAGE) return bodyError("sticker_ids", `Must be ${MAX_STICKERS_PER_MESSAGE} or fewer in length.`);
  return ids.map(id => {
    const sticker = [...db.stickers.values()].flat().find(s => s.id === id);
    if (!sticker) return invalid("sticker_ids", "Unknown sticker.", "UNKNOWN_STICKER");
    if (sticker.guild_id !== channel.guild_id) {
      const member = db.guilds.get(sticker.guild_id)?.members.has(viewerId) ?? false;
      if (!member || !hasBit(channelPermsOf(channel, viewerId), Perm.USE_EXTERNAL_STICKERS)) fail(403, 50013, "Missing Permissions");
    }
    return { id: sticker.id, name: sticker.name, format_type: sticker.format_type, url: sticker.url };
  });
}

// ---- GIFs (generated placeholders) ----

function gifLimit(query: URLSearchParams): number {
  const raw = query.get("limit");
  if (raw === null) return 24;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) return bodyError("limit", "Must be between 1 and 50.");
  return n;
}

function listing(labelFor: (i: number) => string, query: URLSearchParams): GifPage {
  if (db.gifProvider === "none") return { provider: "none", results: [], next: null };
  const { results, next } = gifPage(labelFor, gifLimit(query), query.get("pos"), db.gifProvider);
  return { provider: db.gifProvider, results, next };
}

route("GET", "/gifs/search", ({ query }) => {
  const q = (query.get("q") ?? "").trim();
  if (q === "") return invalid("q", "This field is required", "BASE_TYPE_REQUIRED");
  if (q.length > 100) return bodyError("q", "Must be 100 or fewer in length.");
  return listing(() => q, query);
});

route("GET", "/gifs/trending", ({ query }) => listing(trendingLabel, query));

route("GET", "/gifs/categories", () => (db.gifProvider === "none" ? { provider: "none", categories: [] } : { provider: db.gifProvider, categories: mockCategories() }));

const favorites = (userId: string): Gif[] => db.gifFavorites.get(userId) ?? [];

route("GET", "/users/@me/gifs/favorites", ({ viewer }) => favorites(viewer.user.id));

route("PUT", "/users/@me/gifs/favorites", ({ viewer, body }) => {
  const id = str(body.id);
  const url = str(body.url);
  const preview = str(body.preview_url);
  if (!id || id.length > 200 || !url || !preview) return invalid("id", "A GIF needs id, url and preview_url.", "BASE_TYPE_REQUIRED");
  const gif: Gif = {
    id,
    title: str(body.title) ?? "",
    url,
    preview_url: preview,
    width: typeof body.width === "number" ? body.width : 0,
    height: typeof body.height === "number" ? body.height : 0,
  };
  const rest = favorites(viewer.user.id).filter(g => g.id !== id);
  if (rest.length >= MAX_FAVORITE_GIFS) return bodyError("id", `At most ${MAX_FAVORITE_GIFS} favorite GIFs.`);
  db.gifFavorites.set(viewer.user.id, [gif, ...rest]);
  return gif;
});

route("DELETE", "/users/@me/gifs/favorites/([^/]+)", ({ viewer, params }) => {
  const id = decodeURIComponent(params[0] ?? "");
  db.gifFavorites.set(viewer.user.id, favorites(viewer.user.id).filter(g => g.id !== id));
  return undefined;
});

// ---- forward ----

const CAN_FORWARD = new Set<MessageType>([MessageType.Default, MessageType.Reply]);

/**
 * `message_reference` with `type: 1` → the frozen copy to store. The caller must be able to read the source channel; every failure
 * answers like a plain missing message so a message in a channel the caller cannot read is never confirmed.
 */
export function buildForward(viewerId: string, ref: { message_id?: unknown; channel_id?: unknown }, target: MockChannel): NonNullable<MockMessage["forward"]> {
  const channelId = str(ref.channel_id);
  const messageId = str(ref.message_id);
  if (!channelId || !messageId) return invalid("message_reference", "A forward needs message_id and channel_id.", "BASE_TYPE_REQUIRED");
  const source = db.channels.get(channelId);
  if (!source) return fail(404, 10008, "Unknown Message");
  if (!canAccess(source, viewerId)) return fail(404, 10008, "Unknown Message");
  if (!hasBit(channelPermsOf(source, viewerId), Perm.READ_MESSAGE_HISTORY)) return fail(404, 10008, "Unknown Message");
  const original = requireMessage(channelId, messageId);
  if (!CAN_FORWARD.has(original.type)) return invalid("message_reference", "System messages cannot be forwarded.", "CANNOT_FORWARD");
  if (isPoll(original.id)) return invalid("message_reference", "Polls cannot be forwarded.", "CANNOT_FORWARD");
  // A forward of a forward copies the snapshot content, not the original message.
  const frozen = original.forward?.snapshot.message;
  const snapshot: MessageSnapshot = frozen
    ? { message: { ...(JSON.parse(JSON.stringify(frozen)) as MessageSnapshot["message"]) } }
    : {
        message: {
          type: MessageType.Default,
          content: original.content,
          timestamp: original.timestamp,
          edited_timestamp: original.edited_timestamp,
          mentions: original.mention_ids.map(userOf),
          attachments: original.attachments.map(a => ({ ...a })),
          embeds: (original.embeds ?? []).map(e => ({ ...e })),
          ...(original.stickers?.length ? { sticker_items: original.stickers.map(s => ({ ...s })) } : {}),
        },
      };
  // The target channel's rules apply as for a normal post (server: 403 50013, nothing copied).
  const targetPerms = channelPermsOf(target, viewerId);
  if (snapshot.message.attachments.length > 0 && !hasBit(targetPerms, Perm.ATTACH_FILES)) fail(403, 50013, "Missing Permissions");
  const stickers = snapshot.message.sticker_items ?? [];
  if (stickers.length > 0 && target.guild_id && !hasBit(targetPerms, Perm.USE_EXTERNAL_STICKERS)) {
    const own = new Set((db.stickers.get(target.guild_id) ?? []).map(s => s.id));
    if (stickers.some(s => !own.has(s.id))) fail(403, 50013, "Missing Permissions");
  }
  // Forwarded attachments are copied to new files: new ids, same bytes.
  snapshot.message.attachments = snapshot.message.attachments.map(a => ({ ...a, id: nextId() }));
  return { message_id: messageId, channel_id: channelId, guild_id: source.guild_id, snapshot };
}

// ---- bookmarks ----

const keyOf = (channelId: string, messageId: string): string => `${channelId}:${messageId}`;
const READ_HISTORY = Perm.VIEW_CHANNEL | Perm.READ_MESSAGE_HISTORY;
const canReadMessages = (channel: MockChannel | undefined, userId: string): channel is MockChannel => !!channel && hasBit(channelPermsOf(channel, userId), READ_HISTORY);

function bookmarkFor(userId: string, key: string, savedAt: string): Bookmark | null {
  const [channelId = "", messageId = ""] = key.split(":");
  const channel = db.channels.get(channelId);
  const message = sortedMessages(channelId).find(m => m.id === messageId);
  if (!message || !canReadMessages(channel, userId)) return null;
  return { message: messageFor(message, userId), saved_at: savedAt };
}

route("GET", "/users/@me/bookmarks", ({ viewer, query }) => {
  const limitRaw = query.get("limit");
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return bodyError("limit", "Must be between 1 and 100.");
  const before = query.get("before");
  const beforeId = query.get("before_id"); // with `before`: (saved_at, message id) keyset like the server
  const saved = [...(db.bookmarks.get(viewer.user.id) ?? new Map<string, string>())].reverse(); // newest saved first
  const items: Bookmark[] = [];
  for (const [key, savedAt] of saved) {
    if (before) {
      const at = Date.parse(savedAt);
      const cut = Date.parse(before);
      const messageId = key.split(":")[1] ?? "";
      const older = at < cut || (at === cut && beforeId !== null && BigInt(messageId) < BigInt(beforeId));
      if (!older) continue;
    }
    const bookmark = bookmarkFor(viewer.user.id, key, savedAt);
    if (bookmark) items.push(bookmark);
  }
  return { items: items.slice(0, limit), has_more: items.length > limit };
});

route("PUT", `/channels/${ID}/messages/${ID}/bookmark`, ({ viewer, params }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  if (!canReadMessages(channel, viewer.user.id)) fail(403, 50001, "Missing Access");
  const message = requireMessage(channel.id, params[1] ?? "");
  const mine = db.bookmarks.get(viewer.user.id) ?? new Map<string, string>();
  const key = keyOf(channel.id, message.id);
  if (mine.has(key)) return undefined;
  if (mine.size >= MAX_BOOKMARKS) fail(400, 30090, `Maximum number of bookmarks reached (${MAX_BOOKMARKS})`);
  const savedAt = new Date().toISOString();
  mine.set(key, savedAt);
  db.bookmarks.set(viewer.user.id, mine);
  emit([viewer.user.id], "BOOKMARK_ADD", { message: messageFor(message, viewer.user.id), saved_at: savedAt });
  return undefined;
});

route("DELETE", `/channels/${ID}/messages/${ID}/bookmark`, ({ viewer, params }) => {
  const channelId = params[0] ?? "";
  const messageId = params[1] ?? "";
  if (db.bookmarks.get(viewer.user.id)?.delete(keyOf(channelId, messageId))) emit([viewer.user.id], "BOOKMARK_REMOVE", { channel_id: channelId, message_id: messageId });
  return undefined;
});

// ---- recent mentions (Inbox > Mentions) ----

const boolParam = (query: URLSearchParams, key: string): boolean => {
  const raw = query.get(key);
  if (raw === null || raw === "true") return true;
  return raw === "false" ? false : invalid(key, "Must be true or false.");
};

route("GET", "/users/@me/mentions", ({ viewer, query }) => {
  const me = viewer.user.id;
  const limitRaw = query.get("limit");
  const limit = limitRaw === null ? 25 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return bodyError("limit", "Must be between 1 and 100.");
  const before = query.get("before");
  if (before !== null && !/^\d+$/.test(before)) return invalid("before", "Must be a snowflake.");
  const guildId = query.get("guild_id");
  const [roles, everyone] = [boolParam(query, "roles"), boolParam(query, "everyone")];
  const dismissed = db.mentionDismissals.get(me);
  const hits: MockMessage[] = [];
  for (const channel of db.channels.values()) {
    if (!channel.guild_id || (guildId && channel.guild_id !== guildId) || !canReadMessages(channel, me)) continue;
    const myRoles = db.guilds.get(channel.guild_id)?.members.get(me)?.roles ?? [];
    for (const m of sortedMessages(channel.id)) {
      if (m.author_id === me || dismissed?.has(m.id) || (before && BigInt(m.id) >= BigInt(before))) continue;
      const byRole = roles && [...m.content.matchAll(/<@&(\d+)>/g)].some(r => myRoles.includes(r[1] ?? ""));
      if (m.mention_ids.includes(me) || (everyone && m.mention_everyone) || byRole) hits.push(m);
    }
  }
  hits.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
  return hits.slice(0, limit).map(m => messageFor(m, me));
});

route("DELETE", `/users/@me/mentions/${ID}`, ({ viewer, params }) => {
  const id = params[0] ?? "";
  const set = db.mentionDismissals.get(viewer.user.id) ?? new Set<string>();
  // Like the server: only a new dismissal of a real message is told to the user's other sessions.
  const known = [...db.messages.values()].some(list => list.some(m => m.id === id));
  if (!known || set.has(id)) return undefined;
  set.add(id);
  db.mentionDismissals.set(viewer.user.id, set);
  emit([viewer.user.id], "RECENT_MENTION_DELETE", { message_id: id });
  return undefined;
});

// ---- reminders ----

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** setTimeout cannot wait longer than 2^31-1 ms; a reminder further out is re-armed in slices. */
const MAX_TIMER_MS = 2 ** 31 - 1;

function reminderFor(r: MockReminder): Reminder {
  const { owner_id, ...rest } = r;
  const channel = db.channels.get(r.channel_id);
  const message = sortedMessages(r.channel_id).find(m => m.id === r.message_id);
  return { ...rest, message: message && canReadMessages(channel, owner_id) ? (messageFor(message, owner_id) as Message) : null };
}

function arm(r: MockReminder): void {
  clearTimeout(timers.get(r.id));
  const wait = Date.parse(r.remind_at) - Date.now();
  timers.set(
    r.id,
    setTimeout(() => {
      timers.delete(r.id);
      const live = db.reminders.get(r.id);
      if (!live || live.delivered_at) return;
      if (Date.parse(live.remind_at) - Date.now() > 0) return arm(live); // woke up early (long delay sliced)
      live.delivered_at = new Date().toISOString();
      emit([live.owner_id], "REMINDER_DUE", reminderFor(live));
    }, Math.min(Math.max(wait, 0), MAX_TIMER_MS)),
  );
}

function drop(r: MockReminder): void {
  clearTimeout(timers.get(r.id));
  timers.delete(r.id);
  db.reminders.delete(r.id);
}

route("GET", "/users/@me/reminders", ({ viewer }) =>
  [...db.reminders.values()]
    .filter(r => r.owner_id === viewer.user.id)
    .sort((a, b) => Date.parse(a.remind_at) - Date.parse(b.remind_at))
    .map(reminderFor),
);

route("POST", "/users/@me/reminders", ({ viewer, body }) => {
  const channel = requireChannel(str(body.channel_id) ?? "", viewer.user.id);
  if (!canReadMessages(channel, viewer.user.id)) fail(403, 50001, "Missing Access");
  const message = requireMessage(channel.id, str(body.message_id) ?? "");
  const at = Date.parse(str(body.remind_at) ?? "");
  if (!Number.isFinite(at)) return invalid("remind_at", "Must be an ISO 8601 date.", "BASE_TYPE_BAD_FORMAT");
  if (at <= Date.now()) return invalid("remind_at", "Must be in the future.");
  if (at > Date.now() + MAX_REMIND_AHEAD_MS) return invalid("remind_at", "Must be at most one year ahead.");
  const remindAt = new Date(at).toISOString();
  const existing = [...db.reminders.values()].find(r => r.owner_id === viewer.user.id && r.message_id === message.id);
  if (!existing && [...db.reminders.values()].filter(r => r.owner_id === viewer.user.id && !r.delivered_at).length >= MAX_PENDING_REMINDERS) {
    fail(400, 30091, `Maximum number of reminders reached (${MAX_PENDING_REMINDERS})`);
  }
  // One per user and message: a second call moves it and rearms it.
  const reminder: MockReminder = existing
    ? Object.assign(existing, { remind_at: remindAt, delivered_at: null })
    : { id: nextId(), owner_id: viewer.user.id, channel_id: channel.id, message_id: message.id, guild_id: channel.guild_id, remind_at: remindAt, created_at: new Date().toISOString(), delivered_at: null };
  db.reminders.set(reminder.id, reminder);
  arm(reminder);
  emit([viewer.user.id], "REMINDER_CREATE", reminderFor(reminder));
  return reminderFor(reminder);
});

route("DELETE", `/users/@me/reminders/${ID}`, ({ viewer, params }) => {
  const reminder = db.reminders.get(params[0] ?? "");
  if (reminder && reminder.owner_id === viewer.user.id) {
    drop(reminder);
    emit([viewer.user.id], "REMINDER_DELETE", { id: reminder.id });
  }
  return undefined;
});

// ---- cleanup hooks (called by the message / channel / guild routes) ----

/** A deleted message loses its bookmarks and reminders. */
export function purgeMessageRefs(channelId: string, messageId: string): void {
  for (const [userId, saved] of db.bookmarks) {
    if (saved.delete(keyOf(channelId, messageId))) emit([userId], "BOOKMARK_REMOVE", { channel_id: channelId, message_id: messageId });
  }
  for (const r of [...db.reminders.values()]) {
    if (r.channel_id !== channelId || r.message_id !== messageId) continue;
    drop(r);
    emit([r.owner_id], "REMINDER_DELETE", { id: r.id });
  }
}

export function purgeChannelRefs(channelId: string): void {
  for (const m of sortedMessages(channelId)) purgeMessageRefs(channelId, m.id);
}

/** Deleting a guild removes its stickers. */
export function purgeGuildStickers(guildId: string): void {
  db.stickers.delete(guildId);
}

/** Test/dev hook: forget timers (a fresh database must not fire old reminders). */
export function clearReminderTimers(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
