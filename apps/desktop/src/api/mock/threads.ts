// Mock threads, forum channels and announcement follow / publish: every route of docs/api.md "Threads, forums and announcements",
// with the server's status codes, permission rules and THREAD_* events.

import {
  ChannelFlags,
  ChannelType,
  ForumLayout,
  ForumSortOrder,
  MessageFlags,
  MessageType,
  THREAD_AUTO_ARCHIVE_DURATIONS,
  isThreadType,
  type Channel,
  type ChannelFollower,
  type DefaultReaction,
  type ForumPost,
  type ForumTag,
  type ThreadAutoArchiveDuration,
  type ThreadListResponse,
  type ThreadMember,
  type ThreadSearchResponse,
} from "../types";
import { Perm, hasBit } from "../permissions";
import { compareIds } from "../snowflake";
import { canView, channelPermsOf } from "./access";
import { db, nextId, sortedMessages, type MockChannel, type MockMessage } from "./db";
import { addMessage, channelAudience, fail, messageHooks, pendingAttachment, requireChannel, requireChannelPerm, requireGuildMember, requireMessage, MISSING_PERMISSIONS } from "./ops";
import { ID, route, str } from "./router";
import { emit } from "./socket";
import { channelFor, messageFor } from "./views";

const NAME_MAX = 100;
const TAG_NAME_MAX = 20;
const MAX_FORUM_TAGS = 20;
const MAX_POST_TAGS = 5;
const DEFAULT_ARCHIVE: ThreadAutoArchiveDuration = 1440;
const WRONG_TYPE = "Cannot execute action on this channel type";

const isThread = (channel: MockChannel): boolean => isThreadType(channel.type);
const isForum = (channel: MockChannel): boolean => channel.type === ChannelType.GuildForum;
const hasThreads = (channel: MockChannel): boolean => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement;

function invalid(field: string, code: string, message: string): never {
  return fail(400, 50035, "Invalid Form Body", { [field]: { code, message } });
}

function validName(raw: unknown, max = NAME_MAX): string {
  const name = (typeof raw === "string" ? raw : "").trim();
  if (name.length < 1 || name.length > max) invalid("name", "BASE_TYPE_BAD_LENGTH", `Must be between 1 and ${max} in length.`);
  return name;
}

function archiveDuration(raw: unknown, fallback: ThreadAutoArchiveDuration): ThreadAutoArchiveDuration {
  if (raw === undefined || raw === null) return fallback;
  if (!(THREAD_AUTO_ARCHIVE_DURATIONS as readonly number[]).includes(raw as number)) invalid("auto_archive_duration", "BASE_TYPE_CHOICES", "Value must be one of (60, 1440, 4320, 10080).");
  return raw as ThreadAutoArchiveDuration;
}

const parentOf = (thread: MockChannel): MockChannel | undefined => (thread.parent_id ? db.channels.get(thread.parent_id) : undefined);

/** MANAGE_THREADS in the thread's parent (the thread's own resolved bits do not carry the permission differences, the parent's do). */
export function canManageThreads(thread: MockChannel, userId: string): boolean {
  const parent = parentOf(thread);
  return !!parent && hasBit(channelPermsOf(parent, userId), Perm.MANAGE_THREADS);
}

// ---- views ----

function threadMember(thread: MockChannel, userId: string): ThreadMember | null {
  const joined = thread.thread_members?.get(userId);
  return joined ? { id: thread.id, user_id: userId, join_timestamp: joined, flags: 0 } : null;
}

const membershipsOf = (threads: MockChannel[], userId: string): ThreadMember[] => threads.flatMap(t => threadMember(t, userId) ?? []);

/** Unarchived threads of the guild the viewer can see. */
export function activeThreadsOf(guildId: string, viewerId: string): MockChannel[] {
  sweepArchivedThreads();
  return [...db.channels.values()].filter(c => c.guild_id === guildId && isThread(c) && !c.thread_metadata?.archived && canView(c, viewerId));
}

function emitThread(type: "THREAD_CREATE" | "THREAD_UPDATE", thread: MockChannel, extra: Partial<Channel> = {}, audience: Iterable<string> = channelAudience(thread)): void {
  for (const id of audience) emit([id], type, { ...channelFor(thread, id), ...extra });
}

/** The parent message of a thread started from a message carries `thread`: tell everyone who sees the parent. */
function emitStarterUpdate(thread: MockChannel): void {
  const parent = parentOf(thread);
  const starter = parent ? sortedMessages(parent.id).find(m => m.id === thread.id) : undefined;
  if (parent && starter) for (const id of channelAudience(parent)) emit([id], "MESSAGE_UPDATE", messageFor(starter, id));
}

// ---- membership ----

function emitMembers(thread: MockChannel, change: { added?: string[]; removed?: string[] }, extraAudience: string[] = []): void {
  const added_members = (change.added ?? []).flatMap(id => threadMember(thread, id) ?? []);
  emit(new Set([...channelAudience(thread), ...extraAudience]), "THREAD_MEMBERS_UPDATE", {
    id: thread.id,
    guild_id: thread.guild_id ?? "",
    member_count: thread.thread_members?.size ?? 0,
    ...(added_members.length > 0 ? { added_members } : {}),
    ...(change.removed && change.removed.length > 0 ? { removed_member_ids: change.removed } : {}),
  });
}

/** Adds a member; returns false when they already were one. */
function addMember(thread: MockChannel, userId: string): boolean {
  const members = (thread.thread_members ??= new Map());
  if (members.has(userId)) return false;
  members.set(userId, new Date().toISOString());
  const member = threadMember(thread, userId);
  if (member) emit([userId], "THREAD_MEMBER_UPDATE", { ...member, guild_id: thread.guild_id ?? "" });
  // A private thread only becomes visible to the new member now.
  if (thread.type === ChannelType.PrivateThread) emit([userId], "THREAD_CREATE", channelFor(thread, userId));
  emitMembers(thread, { added: [userId] });
  return true;
}

function removeMember(thread: MockChannel, userId: string): void {
  if (!thread.thread_members?.delete(userId)) return;
  emitMembers(thread, { removed: [userId] }, [userId]);
}

// ---- creation ----

export interface NewThread {
  id?: string;
  parent: MockChannel;
  type?: ChannelType;
  name: string;
  owner_id: string;
  auto_archive_duration?: ThreadAutoArchiveDuration;
  invitable?: boolean;
  applied_tags?: string[];
  /** ms since epoch of the creation (seeding in the past). */
  now?: number;
}

export function createThreadRecord(init: NewThread): MockChannel {
  const { parent } = init;
  const now = init.now ?? Date.now();
  const iso = new Date(now).toISOString();
  const type = init.type ?? (parent.type === ChannelType.GuildAnnouncement ? ChannelType.AnnouncementThread : ChannelType.PublicThread);
  const thread: MockChannel = {
    id: init.id ?? nextId(now),
    type,
    guild_id: parent.guild_id,
    name: init.name,
    topic: null,
    position: 0,
    parent_id: parent.id,
    last_message_id: null,
    owner_id: init.owner_id,
    thread_metadata: {
      archived: false,
      auto_archive_duration: init.auto_archive_duration ?? parent.default_auto_archive_duration ?? DEFAULT_ARCHIVE,
      archive_timestamp: iso,
      locked: false,
      ...(type === ChannelType.PrivateThread ? { invitable: init.invitable ?? true } : {}),
      create_timestamp: iso,
    },
    ...(init.applied_tags ? { applied_tags: [...init.applied_tags] } : {}),
    flags: 0,
    thread_members: new Map([[init.owner_id, iso]]),
  };
  db.channels.set(thread.id, thread);
  return thread;
}

/** A thread from a message: the thread id is the message id and its first message is a type 21 pointer back at the original. */
export function startThreadFromMessage(parent: MockChannel, message: MockMessage, name: string, ownerId: string, duration?: ThreadAutoArchiveDuration, now?: number): MockChannel {
  const thread = createThreadRecord({ id: message.id, parent, name, owner_id: ownerId, auto_archive_duration: duration, now });
  addMessage({ channel: thread, author_id: message.author_id, content: "", type: MessageType.ThreadStarterMessage, reference_id: message.id, reference_channel_id: parent.id, timestamp: now, silent: true });
  return thread;
}

/** Type 18 notice in the parent of a thread started without a message. */
function announceThread(parent: MockChannel, thread: MockChannel, authorId: string, now?: number): void {
  addMessage({ channel: parent, author_id: authorId, content: thread.name ?? "", type: MessageType.ThreadCreated, reference_id: thread.id, reference_channel_id: thread.id, timestamp: now });
}

export interface NewForumPost {
  forum: MockChannel;
  name: string;
  author_id: string;
  content: string;
  tags?: string[];
  auto_archive_duration?: ThreadAutoArchiveDuration;
  attachments?: MockMessage["attachments"];
  now?: number;
  silent?: boolean;
}

export function createForumPost(init: NewForumPost): { thread: MockChannel; message: MockMessage } {
  const now = init.now ?? Date.now();
  const id = nextId(now);
  const thread = createThreadRecord({ id, parent: init.forum, type: ChannelType.PublicThread, name: init.name, owner_id: init.author_id, auto_archive_duration: init.auto_archive_duration, applied_tags: init.tags ?? [], now });
  if (!init.silent) emitThread("THREAD_CREATE", thread, { newly_created: true });
  const message = addMessage({ id, channel: thread, author_id: init.author_id, content: init.content, attachments: init.attachments, timestamp: now, silent: init.silent });
  return { thread, message };
}

// ---- rules shared with the message routes ----

/** Posting into `channel`: forum channels only hold posts, a locked thread needs MANAGE_THREADS. */
export function assertCanPost(channel: MockChannel, userId: string): void {
  if (channel.type === ChannelType.GuildCategory || channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStage || isForum(channel)) fail(400, 50024, WRONG_TYPE);
  if (isThread(channel) && channel.thread_metadata?.locked && !canManageThreads(channel, userId)) fail(403, 160005, "Thread is locked");
}

/** Editing or reacting in an archived thread is refused until it is unarchived (sending a message unarchives it instead). */
export function assertThreadOpen(channel: MockChannel): void {
  if (isThread(channel) && channel.thread_metadata?.archived) fail(403, 50083, "Thread is archived");
}

messageHooks.push((channel, message) => {
  if (!isThread(channel) || !channel.thread_metadata) return;
  if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return;
  if (channel.thread_metadata.archived) {
    channel.thread_metadata.archived = false;
    channel.thread_metadata.archive_timestamp = new Date().toISOString();
    emitThread("THREAD_UPDATE", channel);
  }
  if (db.guilds.get(channel.guild_id ?? "")?.members.has(message.author_id)) addMember(channel, message.author_id);
});

/** Archive threads whose last activity is older than their auto-archive duration; returns their ids. */
export function sweepArchivedThreads(now = Date.now()): string[] {
  const archived: string[] = [];
  for (const thread of db.channels.values()) {
    const meta = thread.thread_metadata;
    if (!isThread(thread) || !meta || meta.archived) continue;
    const last = sortedMessages(thread.id).at(-1);
    const activity = Math.max(last ? Date.parse(last.timestamp) : 0, Date.parse(meta.create_timestamp ?? meta.archive_timestamp));
    if (now - activity < meta.auto_archive_duration * 60_000) continue;
    meta.archived = true;
    meta.archive_timestamp = new Date(now).toISOString();
    emitThread("THREAD_UPDATE", thread);
    archived.push(thread.id);
  }
  return archived;
}

// ---- routes: start ----

route("POST", `/channels/${ID}/messages/${ID}/threads`, ({ viewer, params, body }) => {
  const parent = requireChannel(params[0] ?? "", viewer.user.id);
  if (!hasThreads(parent)) fail(400, 50024, WRONG_TYPE);
  requireChannelPerm(parent, viewer.user.id, Perm.CREATE_PUBLIC_THREADS);
  const message = requireMessage(parent.id, params[1] ?? "");
  const name = validName(body.name);
  const duration = archiveDuration(body.auto_archive_duration, parent.default_auto_archive_duration ?? DEFAULT_ARCHIVE);
  if (db.channels.has(message.id)) fail(400, 160004, "A thread has already been created for this message");
  const thread = startThreadFromMessage(parent, message, name, viewer.user.id, duration);
  emitThread("THREAD_CREATE", thread, { newly_created: true });
  emitStarterUpdate(thread);
  return { ...channelFor(thread, viewer.user.id), newly_created: true };
});

route("POST", `/channels/${ID}/threads`, ({ viewer, params, body }) => {
  const parent = requireChannel(params[0] ?? "", viewer.user.id);
  if (isForum(parent)) return startForumPost(parent, viewer.user.id, body);
  if (!hasThreads(parent)) fail(400, 50024, WRONG_TYPE);
  const priv = body.type === ChannelType.PrivateThread;
  if (body.type !== undefined && body.type !== ChannelType.PublicThread && body.type !== ChannelType.AnnouncementThread && !priv) invalid("type", "BASE_TYPE_CHOICES", "Value must be one of (10, 11, 12).");
  requireChannelPerm(parent, viewer.user.id, priv ? Perm.CREATE_PRIVATE_THREADS : Perm.CREATE_PUBLIC_THREADS);
  const name = validName(body.name);
  const duration = archiveDuration(body.auto_archive_duration, parent.default_auto_archive_duration ?? DEFAULT_ARCHIVE);
  const thread = createThreadRecord({ parent, type: priv ? ChannelType.PrivateThread : undefined, name, owner_id: viewer.user.id, auto_archive_duration: duration, invitable: body.invitable === false ? false : true });
  emitThread("THREAD_CREATE", thread, { newly_created: true });
  if (!priv) announceThread(parent, thread, viewer.user.id);
  return { ...channelFor(thread, viewer.user.id), newly_created: true };
});

function startForumPost(forum: MockChannel, userId: string, body: Record<string, unknown>): ForumPost {
  requireChannelPerm(forum, userId, Perm.SEND_MESSAGES);
  const name = validName(body.name);
  const duration = archiveDuration(body.auto_archive_duration, forum.default_auto_archive_duration ?? DEFAULT_ARCHIVE);
  const tags = Array.isArray(body.applied_tags) ? body.applied_tags.filter((v): v is string => typeof v === "string") : [];
  checkPostTags(forum, tags, userId, []);
  if (tags.length === 0 && ((forum.flags ?? 0) & ChannelFlags.RequireTag) !== 0) fail(400, 220003, "A tag is required to create a forum post in this channel");
  const first = (typeof body.message === "object" && body.message !== null ? body.message : {}) as Record<string, unknown>;
  const content = (str(first.content) ?? "").trim();
  const ids = Array.isArray(first.attachment_ids) ? first.attachment_ids.filter((v): v is string => typeof v === "string") : [];
  const attachments = ids.flatMap(id => pendingAttachment(id, userId) ?? []);
  if (content.length > 2000) invalid("message", "BASE_TYPE_MAX_LENGTH", "Must be 2000 or fewer in length.");
  if (content === "" && attachments.length === 0) invalid("message", "BASE_TYPE_REQUIRED", "This field is required");
  for (const id of ids) db.pending.delete(id);
  const { thread, message } = createForumPost({ forum, name, author_id: userId, content, tags, auto_archive_duration: duration, attachments });
  return { ...channelFor(thread, userId), newly_created: true, message: messageFor(message, userId) };
}

/** Tags must belong to the forum, at most five, and a moderated tag can only be newly applied by MANAGE_THREADS. */
function checkPostTags(forum: MockChannel, tags: string[], userId: string, current: string[]): void {
  if (tags.length > MAX_POST_TAGS) invalid("applied_tags", "BASE_TYPE_MAX_LENGTH", "Must be 5 or fewer in length.");
  const known = forum.available_tags ?? [];
  for (const id of tags) {
    const tag = known.find(t => t.id === id);
    if (!tag) invalid("applied_tags", "INVALID_TAG", "Unknown forum tag");
    if (tag.moderated && !current.includes(id) && !hasBit(channelPermsOf(forum, userId), Perm.MANAGE_THREADS)) fail(403, 50013, MISSING_PERMISSIONS);
  }
}

// ---- routes: members ----

function requireThread(channelId: string, viewerId: string): MockChannel {
  const thread = requireChannel(channelId, viewerId);
  if (!isThread(thread)) fail(400, 50024, WRONG_TYPE);
  return thread;
}

route("PUT", `/channels/${ID}/thread-members/@me`, ({ viewer, params }) => {
  const thread = requireThread(params[0] ?? "", viewer.user.id);
  if (thread.thread_members?.has(viewer.user.id)) return undefined;
  if (thread.thread_metadata?.archived) fail(403, 50083, "Thread is archived");
  addMember(thread, viewer.user.id);
  return undefined;
});

route("PUT", `/channels/${ID}/thread-members/${ID}`, ({ viewer, params }) => {
  const thread = requireThread(params[0] ?? "", viewer.user.id);
  const targetId = params[1] ?? "";
  requireChannelPerm(thread, viewer.user.id, Perm.SEND_MESSAGES); // SEND_MESSAGES_IN_THREADS of the parent
  const mine = thread.thread_members?.has(viewer.user.id) ?? false;
  const allowed = thread.owner_id === viewer.user.id || canManageThreads(thread, viewer.user.id) || (thread.type === ChannelType.PrivateThread && mine && thread.thread_metadata?.invitable !== false);
  if (!allowed) fail(403, 50013, MISSING_PERMISSIONS);
  if (!db.accounts.has(targetId)) fail(404, 10013, "Unknown User");
  const parent = parentOf(thread);
  if (!parent || !db.guilds.get(thread.guild_id ?? "")?.members.has(targetId) || !canView(parent, targetId)) invalid("user_id", "INVALID", "That user cannot see this channel");
  if (thread.thread_metadata?.archived) fail(403, 50083, "Thread is archived");
  addMember(thread, targetId);
  return undefined;
});

route("DELETE", `/channels/${ID}/thread-members/@me`, ({ viewer, params }) => {
  removeMember(requireThread(params[0] ?? "", viewer.user.id), viewer.user.id);
  return undefined;
});

route("DELETE", `/channels/${ID}/thread-members/${ID}`, ({ viewer, params }) => {
  const thread = requireThread(params[0] ?? "", viewer.user.id);
  if (thread.owner_id !== viewer.user.id && !canManageThreads(thread, viewer.user.id)) fail(403, 50013, MISSING_PERMISSIONS);
  removeMember(thread, params[1] ?? "");
  return undefined;
});

route("GET", `/channels/${ID}/thread-members`, ({ viewer, params }) => {
  const thread = requireThread(params[0] ?? "", viewer.user.id);
  return [...(thread.thread_members?.keys() ?? [])].flatMap(id => threadMember(thread, id) ?? []);
});

route("GET", `/channels/${ID}/thread-members/${ID}`, ({ viewer, params }) => {
  const thread = requireThread(params[0] ?? "", viewer.user.id);
  return threadMember(thread, params[1] ?? "") ?? fail(404, 10065, "Unknown Thread Member");
});

// ---- routes: lists ----

function listResponse(threads: MockChannel[], viewerId: string, hasMore: boolean): ThreadListResponse {
  return { threads: threads.map(t => channelFor(t, viewerId)), members: membershipsOf(threads, viewerId), has_more: hasMore };
}

function archivedPage(candidates: MockChannel[], viewerId: string, query: URLSearchParams): ThreadListResponse {
  sweepArchivedThreads();
  const limit = Math.min(100, Math.max(1, Number(query.get("limit") ?? 50) || 50));
  const before = query.get("before");
  const archiveTime = (t: MockChannel) => Date.parse(t.thread_metadata?.archive_timestamp ?? "");
  const sorted = candidates
    .filter(t => t.thread_metadata?.archived && canView(t, viewerId))
    .filter(t => !before || archiveTime(t) < Date.parse(before))
    .sort((a, b) => archiveTime(b) - archiveTime(a) || compareIds(b.id, a.id));
  return listResponse(sorted.slice(0, limit), viewerId, sorted.length > limit);
}

const threadsOf = (parentId: string, types: ChannelType[]): MockChannel[] => [...db.channels.values()].filter(c => c.parent_id === parentId && types.includes(c.type));

route("GET", `/guilds/${ID}/threads/active`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  return listResponse(activeThreadsOf(guildId, viewer.user.id), viewer.user.id, false);
});

route("GET", `/channels/${ID}/threads/archived/public`, ({ viewer, params, query }) => {
  const parent = requireChannel(params[0] ?? "", viewer.user.id);
  if (!hasThreads(parent) && !isForum(parent)) fail(400, 50024, WRONG_TYPE);
  requireChannelPerm(parent, viewer.user.id, Perm.READ_MESSAGE_HISTORY);
  return archivedPage(threadsOf(parent.id, [ChannelType.PublicThread, ChannelType.AnnouncementThread]), viewer.user.id, query);
});

route("GET", `/channels/${ID}/threads/archived/private`, ({ viewer, params, query }) => {
  const parent = requireChannel(params[0] ?? "", viewer.user.id);
  if (!hasThreads(parent)) fail(400, 50024, WRONG_TYPE);
  requireChannelPerm(parent, viewer.user.id, Perm.MANAGE_THREADS);
  return archivedPage(threadsOf(parent.id, [ChannelType.PrivateThread]), viewer.user.id, query);
});

route("GET", `/channels/${ID}/users/@me/threads/archived/private`, ({ viewer, params, query }) => {
  const parent = requireChannel(params[0] ?? "", viewer.user.id);
  if (!hasThreads(parent)) fail(400, 50024, WRONG_TYPE);
  return archivedPage(threadsOf(parent.id, [ChannelType.PrivateThread]).filter(t => t.thread_members?.has(viewer.user.id)), viewer.user.id, query);
});

/** Forum page query: tag filter, title search, pinned first, sort by last activity or creation. */
route("GET", `/channels/${ID}/threads/search`, ({ viewer, params, query }): ThreadSearchResponse => {
  const parent = requireChannel(params[0] ?? "", viewer.user.id);
  if (!hasThreads(parent) && !isForum(parent)) fail(400, 50024, WRONG_TYPE);
  sweepArchivedThreads();
  const text = (query.get("name") ?? "").trim().toLowerCase();
  const tags = query.getAll("tag");
  const matchAll = query.get("tag_setting") === "match_all";
  const archived = query.get("archived");
  const sortBy = query.get("sort_by") ?? (parent.default_sort_order === ForumSortOrder.CreationDate ? "creation_time" : "last_message_time");
  const direction = query.get("sort_order") === "asc" ? 1 : -1;
  const limit = Math.min(25, Math.max(1, Number(query.get("limit") ?? 25) || 25));
  const offset = Math.max(0, Number(query.get("offset") ?? 0) || 0);
  const created = (t: MockChannel) => Date.parse(t.thread_metadata?.create_timestamp ?? t.thread_metadata?.archive_timestamp ?? "") || 0;
  const activity = (t: MockChannel) => sortedMessages(t.id).at(-1)?.id ?? t.id;
  const pinned = (t: MockChannel) => (((t.flags ?? 0) & ChannelFlags.Pinned) !== 0 ? 1 : 0);
  const hits = [...db.channels.values()]
    .filter(t => isThread(t) && t.parent_id === parent.id && canView(t, viewer.user.id))
    .filter(t => !text || (t.name ?? "").toLowerCase().includes(text))
    .filter(t => archived === null || (archived === "true") === !!t.thread_metadata?.archived)
    .filter(t => tags.length === 0 || (matchAll ? tags.every(id => t.applied_tags?.includes(id)) : tags.some(id => t.applied_tags?.includes(id))))
    .sort((a, b) => pinned(b) - pinned(a) || direction * (sortBy === "creation_time" ? created(a) - created(b) || compareIds(a.id, b.id) : compareIds(activity(a), activity(b))));
  const page = hits.slice(offset, offset + limit);
  const first_messages = page.flatMap(t => {
    const list = sortedMessages(t.id);
    const first = list.find(m => m.id === t.id) ?? list[0];
    return first ? [messageFor(first, viewer.user.id)] : [];
  });
  return { threads: page.map(t => channelFor(t, viewer.user.id)), members: membershipsOf(page, viewer.user.id), first_messages, has_more: offset + page.length < hits.length, total_results: hits.length };
});

// ---- edit / delete (called from the generic channel routes) ----

/** PATCH /channels/{thread}. Owner or MANAGE_THREADS; `locked` and `flags` need MANAGE_THREADS. */
export function editThread(thread: MockChannel, viewerId: string, body: Record<string, unknown>): Channel {
  const meta = thread.thread_metadata;
  if (!meta) fail(400, 50024, WRONG_TYPE);
  const manage = canManageThreads(thread, viewerId);
  if (thread.owner_id !== viewerId && !manage) fail(403, 50013, MISSING_PERMISSIONS);
  if (meta.locked && !manage) fail(403, 160005, "Thread is locked");
  if (("locked" in body || "flags" in body) && !manage) fail(403, 50013, MISSING_PERMISSIONS);
  const others = ["name", "auto_archive_duration", "invitable", "applied_tags", "locked", "flags"].some(key => key in body);
  if (meta.archived && body.archived !== false && others) fail(403, 50083, "Thread is archived");
  const name = "name" in body ? validName(body.name) : undefined;
  const duration = "auto_archive_duration" in body ? archiveDuration(body.auto_archive_duration, meta.auto_archive_duration) : undefined;
  const parent = parentOf(thread);
  let tags: string[] | undefined;
  if ("applied_tags" in body) {
    tags = Array.isArray(body.applied_tags) ? body.applied_tags.filter((v): v is string => typeof v === "string") : [];
    if (parent) checkPostTags(parent, tags, viewerId, thread.applied_tags ?? []);
    if (tags.length === 0 && parent && ((parent.flags ?? 0) & ChannelFlags.RequireTag) !== 0) fail(400, 220003, "A tag is required to create a forum post in this channel");
  }
  if (typeof body.flags === "number" && (body.flags & ChannelFlags.Pinned) !== 0 && !(parent && isForum(parent))) invalid("flags", "INVALID", "Only forum posts can be pinned");

  if (name !== undefined) thread.name = name;
  if (duration !== undefined) meta.auto_archive_duration = duration;
  if (typeof body.invitable === "boolean") meta.invitable = body.invitable;
  if (tags) thread.applied_tags = tags;
  if (typeof body.locked === "boolean") meta.locked = body.locked;
  if (typeof body.flags === "number") thread.flags = body.flags & ChannelFlags.Pinned;
  if (typeof body.archived === "boolean" && body.archived !== meta.archived) {
    meta.archived = body.archived;
    meta.archive_timestamp = new Date().toISOString();
  }
  emitThread("THREAD_UPDATE", thread);
  return channelFor(thread, viewerId);
}

function removeThreadRecord(thread: MockChannel): void {
  const audience = channelAudience(thread);
  const parent = parentOf(thread);
  emit(audience, "THREAD_DELETE", { id: thread.id, guild_id: thread.guild_id ?? "", parent_id: thread.parent_id ?? "", type: thread.type });
  db.channels.delete(thread.id);
  db.messages.delete(thread.id);
  const starter = parent ? sortedMessages(parent.id).find(m => m.id === thread.id) : undefined;
  if (parent && starter) for (const id of channelAudience(parent)) emit([id], "MESSAGE_UPDATE", messageFor(starter, id));
}

/** DELETE /channels/{thread}: owner or MANAGE_THREADS. */
export function deleteThread(thread: MockChannel, viewerId: string): Channel {
  if (thread.owner_id !== viewerId && !canManageThreads(thread, viewerId)) fail(403, 50013, MISSING_PERMISSIONS);
  const payload = channelFor(thread, viewerId);
  removeThreadRecord(thread);
  return payload;
}

/** Deleting a channel deletes its threads (THREAD_DELETE each) and the follows that start or end there. */
export function dropChannelExtras(channel: MockChannel): void {
  for (const thread of [...db.channels.values()]) if (isThread(thread) && thread.parent_id === channel.id) removeThreadRecord(thread);
  for (const [id, follow] of db.followers) if (follow.source_channel_id === channel.id || follow.target_channel_id === channel.id) db.followers.delete(id);
}

// ---- forum channel fields ----

function tagOf(raw: unknown, existing: ForumTag[]): ForumTag {
  const item = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const name = validName(item.name, TAG_NAME_MAX);
  const id = str(item.id);
  const kept = id ? existing.find(t => t.id === id) : undefined;
  if (id && !kept) invalid("available_tags", "INVALID_TAG", "Unknown forum tag");
  return { id: kept?.id ?? nextId(), name, moderated: item.moderated === true, emoji_id: str(item.emoji_id) ?? null, emoji_name: str(item.emoji_name) ?? null };
}

/** Fields of POST/PATCH guild channel for forum, announcement and text channels. The caller has checked MANAGE_CHANNELS. */
export function applyChannelFields(channel: MockChannel, body: Record<string, unknown>): void {
  if ("default_auto_archive_duration" in body && (hasThreads(channel) || isForum(channel))) channel.default_auto_archive_duration = archiveDuration(body.default_auto_archive_duration, DEFAULT_ARCHIVE);
  if (!isForum(channel)) return;
  if ("default_sort_order" in body) {
    if (body.default_sort_order !== ForumSortOrder.LatestActivity && body.default_sort_order !== ForumSortOrder.CreationDate) invalid("default_sort_order", "BASE_TYPE_CHOICES", "Value must be one of (0, 1).");
    channel.default_sort_order = body.default_sort_order;
  }
  if ("default_forum_layout" in body) {
    if (body.default_forum_layout !== ForumLayout.NotSet && body.default_forum_layout !== ForumLayout.List && body.default_forum_layout !== ForumLayout.Gallery) invalid("default_forum_layout", "BASE_TYPE_CHOICES", "Value must be one of (0, 1, 2).");
    channel.default_forum_layout = body.default_forum_layout;
  }
  if ("default_reaction_emoji" in body) {
    const raw = body.default_reaction_emoji as Partial<DefaultReaction> | null;
    if (raw === null) delete channel.default_reaction_emoji;
    else channel.default_reaction_emoji = { emoji_id: str(raw?.emoji_id) ?? null, emoji_name: str(raw?.emoji_name) ?? null };
  }
  if (typeof body.flags === "number") channel.flags = ((channel.flags ?? 0) & ~ChannelFlags.RequireTag) | (body.flags & ChannelFlags.RequireTag);
  if ("available_tags" in body) {
    if (!Array.isArray(body.available_tags) || body.available_tags.length > MAX_FORUM_TAGS) invalid("available_tags", "BASE_TYPE_MAX_LENGTH", "Must be 20 or fewer in length.");
    const existing = channel.available_tags ?? [];
    const next = body.available_tags.map(raw => tagOf(raw, existing));
    const gone = existing.filter(t => !next.some(n => n.id === t.id)).map(t => t.id);
    channel.available_tags = next;
    // Removing a tag removes it from the posts that carry it.
    if (gone.length > 0) {
      for (const post of db.channels.values()) {
        if (post.parent_id !== channel.id || !post.applied_tags?.some(id => gone.includes(id))) continue;
        post.applied_tags = post.applied_tags.filter(id => !gone.includes(id));
        emitThread("THREAD_UPDATE", post);
      }
    }
  }
}

/** A channel created with a forum / announcement / stage type: forums always carry their tag list. */
export function initChannelFields(channel: MockChannel, body: Record<string, unknown>): void {
  if (isForum(channel)) channel.available_tags = [];
  applyChannelFields(channel, body);
}

// ---- announcements: follow and publish ----

function requireFollowSource(channelId: string, viewerId: string): MockChannel {
  const source = requireChannel(channelId, viewerId);
  if (source.type !== ChannelType.GuildAnnouncement) invalid("channel_id", "INVALID", "Only announcement channels can be followed");
  return source;
}

route("POST", `/channels/${ID}/followers`, ({ viewer, params, body }) => {
  const source = requireFollowSource(params[0] ?? "", viewer.user.id);
  const target = db.channels.get(str(body.webhook_channel_id) ?? "");
  if (!target || !target.guild_id) invalid("webhook_channel_id", "INVALID", "Unknown channel");
  if (!hasThreads(target)) invalid("webhook_channel_id", "INVALID", "Pick a text or announcement channel");
  if (target.id === source.id) invalid("webhook_channel_id", "INVALID", "A channel cannot follow itself");
  if (!db.guilds.get(target.guild_id)?.members.has(viewer.user.id) || !canView(target, viewer.user.id)) fail(403, 50001, "Missing Access");
  requireChannelPerm(target, viewer.user.id, Perm.MANAGE_WEBHOOKS);
  const existing = [...db.followers.values()].find(f => f.source_channel_id === source.id && f.target_channel_id === target.id);
  if (existing) return { channel_id: source.id, webhook_id: existing.id };
  const follow = { id: nextId(), source_channel_id: source.id, target_channel_id: target.id, created_by: viewer.user.id };
  db.followers.set(follow.id, follow);
  return { channel_id: source.id, webhook_id: follow.id };
});

route("GET", `/channels/${ID}/followers`, ({ viewer, params }): ChannelFollower[] => {
  const target = requireChannel(params[0] ?? "", viewer.user.id);
  requireChannelPerm(target, viewer.user.id, Perm.MANAGE_WEBHOOKS);
  return [...db.followers.values()]
    .filter(f => f.target_channel_id === target.id)
    .flatMap(f => {
      const source = db.channels.get(f.source_channel_id);
      const guild = source?.guild_id ? db.guilds.get(source.guild_id) : undefined;
      if (!source || !guild) return [];
      return [{ id: f.id, channel_id: target.id, guild_id: target.guild_id ?? "", source_channel_id: source.id, source_channel_name: source.name ?? "", source_guild_id: guild.guild.id, source_guild_name: guild.guild.name }];
    });
});

route("DELETE", `/channels/${ID}/followers/${ID}`, ({ viewer, params }) => {
  const target = requireChannel(params[0] ?? "", viewer.user.id);
  requireChannelPerm(target, viewer.user.id, Perm.MANAGE_WEBHOOKS);
  const follow = db.followers.get(params[1] ?? "");
  if (!follow || follow.target_channel_id !== target.id) fail(404, 10015, "Unknown Webhook");
  db.followers.delete(follow.id);
  return undefined;
});

route("POST", `/channels/${ID}/messages/${ID}/crosspost`, ({ viewer, params }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  if (channel.type !== ChannelType.GuildAnnouncement) fail(400, 50024, WRONG_TYPE);
  const message = requireMessage(channel.id, params[1] ?? "");
  requireChannelPerm(channel, viewer.user.id, message.author_id === viewer.user.id ? Perm.SEND_MESSAGES : Perm.MANAGE_MESSAGES);
  if (message.type !== MessageType.Default && message.type !== MessageType.Reply) fail(400, 50024, WRONG_TYPE);
  if (((message.flags ?? 0) & MessageFlags.Crossposted) !== 0) fail(400, 40033, "This message has already been crossposted");
  // The copy is a regular message by the original author; attachments are not forwarded in this version.
  for (const follow of db.followers.values()) {
    const target = follow.source_channel_id === channel.id ? db.channels.get(follow.target_channel_id) : undefined;
    if (!target) continue;
    addMessage({ channel: target, author_id: message.author_id, content: message.content, type: MessageType.Default, reference_id: message.id, reference_channel_id: channel.id, flags: MessageFlags.IsCrosspost });
  }
  message.flags = (message.flags ?? 0) | MessageFlags.Crossposted;
  for (const id of channelAudience(channel)) emit([id], "MESSAGE_UPDATE", messageFor(message, id));
  return messageFor(message, viewer.user.id);
});
