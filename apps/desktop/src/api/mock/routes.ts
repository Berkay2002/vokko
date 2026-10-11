// Mock REST router: every route of docs/api.md that the UI uses, with the same status codes and error codes.

import { ChannelType, MessageType, RelationshipType, isThreadType, type Attachment, type Channel, type Guild, type GuildMember, type Message, type ReactionEmoji, type Relationship, type User } from "../types";
import { compareIds } from "../snowflake";
import { Perm, hasBit } from "../permissions";
import { channelPermsOf } from "./access";
import { db, nextId, sortedMessages, userOf, type MockAccount, type MockChannel } from "./db";
import { pendingAttachment, addChannel, addMessage, canAccess, channelAudience, createAccount, createGuildRecord, fail, openDM, openGroupDM, requireChannel, requireChannelPerm, requireGuildMember, requireGuildPerm, requireMessage, emitVisibilityChanges, visibilityOf } from "./ops";
import { buildForward, purgeChannelRefs, purgeGuildStickers, purgeMessageRefs, resolveStickers } from "./media";
import { parseOverwrites } from "./moderation";
import { applyChannelFields, assertCanPost, assertThreadOpen, deleteThread, dropChannelExtras, editThread, initChannelFields } from "./threads";
import { applyGuildPerks, applyUserPerks, dropTagOnLeave, memberProfileFields } from "./perks";
import { ID, route, routes, str } from "./router";
import { emit } from "./socket";
import { onboardingStartedFor, eventsChannelRemoved } from "./community";
import { flagsField } from "./memberFlags";
import { setVoiceChannelStatus } from "./voice";
import { channelFor, guildPayload, membersOf, messageFor, privateChannelsFor, relationship, relationshipsFor, setRelationship } from "./views";
import "./search";
import "./community";

export { route, str, requireGuildMember };

function parseEmoji(raw: string): ReactionEmoji {
  const decoded = decodeURIComponent(raw);
  const idx = decoded.lastIndexOf(":");
  if (idx > 0 && /^\d+$/.test(decoded.slice(idx + 1))) return { id: decoded.slice(idx + 1), name: decoded.slice(0, idx) };
  return { id: null, name: decoded };
}

const sameEmoji = (a: ReactionEmoji, b: ReactionEmoji) => a.id === b.id && a.name === b.name;

// ---- auth ----


// ---- users ----

route("GET", "/users/@me", ({ viewer }) => viewer.user);

route("PATCH", "/users/@me", ({ viewer, body }) => {
  const user = viewer.user;
  if ("global_name" in body) {
    const value = str(body.global_name)?.trim() ?? "";
    if (value.length > 32) fail(400, 50035, "Invalid Form Body", { global_name: { code: "BASE_TYPE_MAX_LENGTH", message: "Must be 32 or fewer in length." } });
    user.global_name = value === "" ? null : value;
  }
  if ("bio" in body) {
    const value = str(body.bio)?.trim() ?? "";
    if (value.length > 190) fail(400, 50035, "Invalid Form Body", { bio: { code: "BASE_TYPE_MAX_LENGTH", message: "Must be 190 or fewer in length." } });
    user.bio = value === "" ? null : value;
  }
  if ("banner_color" in body) {
    const value = body.banner_color;
    if (value !== null && !(typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value))) fail(400, 50035, "Invalid Form Body", { banner_color: { code: "COLOR_TYPE_CONVERT", message: "Not a valid color." } });
    user.banner_color = value as string | null;
  }
  if ("avatar_attachment_id" in body) {
    const attachment = pendingAttachment(str(body.avatar_attachment_id), user.id);
    user.avatar = attachment ? attachment.url : null;
  }
  applyUserPerks(user, body, id => pendingAttachment(id, user.id));
  const audience = new Set<string>([user.id, ...viewer.relationships.keys()]);
  for (const guild of db.guilds.values()) if (guild.members.has(user.id)) for (const id of guild.members.keys()) audience.add(id);
  for (const channel of db.channels.values()) if (channel.participant_ids?.includes(user.id)) for (const id of channel.participant_ids) audience.add(id);
  emit(audience, "USER_UPDATE", { ...user });
  return user;
});

route("GET", `/users/${ID}`, ({ params }) => {
  const account = db.accounts.get(params[0] ?? "");
  if (!account) fail(404, 10013, "Unknown User");
  return account.user;
});

route("GET", `/users/${ID}/profile`, ({ viewer, params, query }) => {
  const other = db.accounts.get(params[0] ?? "");
  if (!other) fail(404, 10013, "Unknown User");
  const mutual_guilds = [...db.guilds.values()]
    .filter(g => g.members.has(viewer.user.id) && g.members.has(other.user.id))
    .map(g => ({ id: g.guild.id, nick: g.members.get(other.user.id)?.nick ?? null }));
  const mine = new Set([...viewer.relationships].filter(([, t]) => t === RelationshipType.Friend).map(([id]) => id));
  const mutual_friends_count = [...other.relationships].filter(([id, t]) => t === RelationshipType.Friend && mine.has(id)).length;
  const guildId = query.get("guild_id");
  const record = guildId ? db.guilds.get(guildId)?.members.get(other.user.id) : undefined;
  const guild_member: GuildMember | undefined = record
    ? { user: other.user, nick: record.nick, roles: record.roles, joined_at: record.joined_at, ...(record.communication_disabled_until ? { communication_disabled_until: record.communication_disabled_until } : {}), ...memberProfileFields(record), ...flagsField(guildId ?? "", other.user.id) }
    : undefined;
  return { user: other.user, mutual_guilds, mutual_friends_count, ...(guild_member ? { guild_member } : {}) };
});

route("GET", "/users/@me/guilds", ({ viewer }) =>
  [...db.guilds.values()].filter(g => g.members.has(viewer.user.id)).map((g): Guild => ({ ...g.guild })),
);

route("DELETE", `/users/@me/guilds/${ID}`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  const guild = requireGuildMember(guildId, viewer.user.id);
  if (guild.guild.owner_id === viewer.user.id) fail(400, 50035, "Invalid Form Body", { guild: { code: "OWNER_CANNOT_LEAVE", message: "Owners cannot leave their server. Transfer ownership or delete it." } });
  guild.members.delete(viewer.user.id);
  dropTagOnLeave(guild, viewer.user.id);
  emit([viewer.user.id], "GUILD_DELETE", { id: guildId });
  emit(guild.members.keys(), "GUILD_MEMBER_REMOVE", { guild_id: guildId, user: viewer.user });
  return undefined;
});

route("GET", "/users/@me/channels", ({ viewer }) => privateChannelsFor(viewer.user.id));

route("POST", "/users/@me/channels", ({ viewer, body }) => {
  const recipient = str(body.recipient_id);
  if (recipient) {
    if (!db.accounts.has(recipient)) fail(404, 10013, "Unknown User");
    if (recipient === viewer.user.id) fail(400, 50035, "Invalid Form Body", { recipient_id: { code: "CANNOT_DM_SELF", message: "Cannot send messages to yourself" } });
    return channelFor(openDM(viewer.user.id, recipient), viewer.user.id);
  }
  const recipients = Array.isArray(body.recipient_ids) ? body.recipient_ids.filter((v): v is string => typeof v === "string") : [];
  if (recipients.length === 0 || recipients.some(id => !db.accounts.has(id))) fail(400, 50035, "Invalid Form Body", { recipient_ids: { code: "INVALID", message: "Invalid recipients" } });
  if (recipients.length === 1 && recipients[0]) return channelFor(openDM(viewer.user.id, recipients[0]), viewer.user.id);
  return channelFor(openGroupDM(viewer.user.id, recipients), viewer.user.id);
});

// ---- relationships ----

route("GET", "/users/@me/relationships", ({ viewer }) => relationshipsFor(viewer.user.id));

function addRelationship(viewerId: string, otherId: string): void {
  if (viewerId === otherId) fail(400, 80007, "You cannot send yourself a friend request.");
  const current = relationship(viewerId, otherId)?.type;
  if (current === RelationshipType.Friend || current === RelationshipType.OutgoingRequest) return;
  if (relationship(otherId, viewerId)?.type === RelationshipType.Blocked) fail(403, 80000, "Cannot send friend request to this user");
  const accept = current === RelationshipType.IncomingRequest;
  const mine = accept ? RelationshipType.Friend : RelationshipType.OutgoingRequest;
  const theirs = accept ? RelationshipType.Friend : RelationshipType.IncomingRequest;
  setRelationship(viewerId, otherId, mine, theirs);
  const toMe: Relationship = { id: otherId, type: mine, user: userOf(otherId) };
  const toThem: Relationship = { id: viewerId, type: theirs, user: userOf(viewerId) };
  emit([viewerId], "RELATIONSHIP_ADD", toMe);
  emit([otherId], "RELATIONSHIP_ADD", toThem);
}

route("PUT", `/users/@me/relationships/${ID}`, ({ viewer, params, body }) => {
  const id = params[0] ?? "";
  if (!db.accounts.has(id)) fail(404, 10013, "Unknown User");
  if (body.type === RelationshipType.Blocked) {
    if (id === viewer.user.id) fail(400, 80007, "You cannot block yourself.");
    const theirs = relationship(id, viewer.user.id);
    // Blocking drops any friendship or request on the other side too (unless they blocked us: that stays).
    const dropsTheirs = theirs && theirs.type !== RelationshipType.Blocked;
    setRelationship(viewer.user.id, id, RelationshipType.Blocked, dropsTheirs ? null : (theirs?.type ?? null));
    emit([viewer.user.id], "RELATIONSHIP_ADD", { id, type: RelationshipType.Blocked, user: userOf(id) } satisfies Relationship);
    if (dropsTheirs) emit([id], "RELATIONSHIP_REMOVE", { id: viewer.user.id });
    return undefined;
  }
  addRelationship(viewer.user.id, id);
  return undefined;
});

route("POST", "/users/@me/relationships", ({ viewer, body }) => {
  const username = (str(body.username) ?? "").trim().toLowerCase();
  const target = [...db.accounts.values()].find(a => a.user.username === username);
  if (!target) fail(404, 10013, "Unknown User");
  addRelationship(viewer.user.id, target.user.id);
  return undefined;
});

route("DELETE", `/users/@me/relationships/${ID}`, ({ viewer, params }) => {
  const id = params[0] ?? "";
  const current = relationship(viewer.user.id, id);
  if (!current) return undefined;
  const theirs = relationship(id, viewer.user.id);
  const dropsTheirs = current.type !== RelationshipType.Blocked && theirs && theirs.type !== RelationshipType.Blocked;
  setRelationship(viewer.user.id, id, null, dropsTheirs ? null : (theirs?.type ?? null));
  emit([viewer.user.id], "RELATIONSHIP_REMOVE", { id });
  if (dropsTheirs) emit([id], "RELATIONSHIP_REMOVE", { id: viewer.user.id });
  return undefined;
});

// ---- guilds ----

route("POST", "/guilds", ({ viewer, body }) => {
  const name = (str(body.name) ?? "").trim();
  if (name.length < 2 || name.length > 100) fail(400, 50035, "Invalid Form Body", { name: { code: "BASE_TYPE_BAD_LENGTH", message: "Must be between 2 and 100 in length." } });
  const icon = pendingAttachment(str(body.icon_attachment_id), viewer.user.id);
  const id = createGuildRecord(viewer.user.id, name, icon?.url ?? null);
  emit([viewer.user.id], "GUILD_CREATE", guildPayload(id, viewer.user.id));
  return db.guilds.get(id)?.guild;
});

route("GET", `/guilds/${ID}`, ({ viewer, params }) => requireGuildMember(params[0] ?? "", viewer.user.id).guild);

route("PATCH", `/guilds/${ID}`, ({ viewer, params, body }) => {
  const guild = requireGuildPerm(params[0] ?? "", viewer.user.id, Perm.MANAGE_GUILD);
  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (name.length < 2 || name.length > 100) fail(400, 50035, "Invalid Form Body", { name: { code: "BASE_TYPE_BAD_LENGTH", message: "Must be between 2 and 100 in length." } });
    guild.guild.name = name;
  }
  if ("icon_attachment_id" in body) guild.guild.icon = pendingAttachment(str(body.icon_attachment_id), viewer.user.id)?.url ?? null;
  if ("system_channel_id" in body) guild.guild.system_channel_id = str(body.system_channel_id) ?? null;
  applyGuildPerks(guild, body);
  emit(guild.members.keys(), "GUILD_UPDATE", { ...guild.guild });
  return guild.guild;
});

route("DELETE", `/guilds/${ID}`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  const guild = requireGuildMember(guildId, viewer.user.id);
  if (guild.guild.owner_id !== viewer.user.id) fail(403, 50013, "Missing Permissions");
  emit(guild.members.keys(), "GUILD_DELETE", { id: guildId });
  db.guilds.delete(guildId);
  for (const channel of [...db.channels.values()]) {
    if (channel.guild_id !== guildId) continue;
    purgeChannelRefs(channel.id);
    db.channels.delete(channel.id);
    db.messages.delete(channel.id);
  }
  purgeGuildStickers(guildId);
  return undefined;
});

route("GET", `/guilds/${ID}/channels`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  return [...db.channels.values()].filter(c => c.guild_id === guildId && !isThreadType(c.type) && canAccess(c, viewer.user.id)).map(c => channelFor(c, viewer.user.id));
});

route("POST", `/guilds/${ID}/channels`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  requireGuildPerm(guildId, viewer.user.id, Perm.MANAGE_CHANNELS);
  const type = body.type;
  const creatable = [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.GuildAnnouncement, ChannelType.GuildStage, ChannelType.GuildForum];
  if (typeof type !== "number" || !creatable.includes(type)) fail(400, 50035, "Invalid Form Body", { type: { code: "BASE_TYPE_CHOICES", message: "Value must be one of (0, 2, 4, 5, 13, 15)." } });
  const name = (str(body.name) ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  if (name.length < 1 || name.length > 100) fail(400, 50035, "Invalid Form Body", { name: { code: "BASE_TYPE_BAD_LENGTH", message: "Must be between 1 and 100 in length." } });
  const parent = str(body.parent_id) ?? null;
  if (parent && db.channels.get(parent)?.guild_id !== guildId) fail(400, 50035, "Invalid Form Body", { parent_id: { code: "INVALID", message: "Unknown category" } });
  const permission_overwrites = parseOverwrites(guildId, viewer.user.id, body.permission_overwrites);
  const explicit = body.permission_overwrites !== undefined && body.permission_overwrites !== null;
  const channel = addChannel(guildId, { name, type, parent_id: type === ChannelType.GuildCategory ? null : parent, topic: str(body.topic) ?? null, permission_overwrites: explicit ? permission_overwrites : undefined });
  initChannelFields(channel, body);
  for (const id of channelAudience(channel)) emit([id], "CHANNEL_CREATE", channelFor(channel, id));
  return channelFor(channel, viewer.user.id);
});

route("GET", `/guilds/${ID}/members`, ({ viewer, params, query }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  const limit = Math.min(1000, Math.max(1, Number(query.get("limit") ?? 100) || 100));
  const after = query.get("after");
  return membersOf(guildId)
    .sort((a, b) => compareIds(a.user.id, b.user.id))
    .filter((m): m is GuildMember => (after ? compareIds(m.user.id, after) > 0 : true))
    .slice(0, limit);
});

// ---- channels ----

route("PATCH", `/channels/${ID}`, ({ viewer, params, body }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  if (isThreadType(channel.type)) return editThread(channel, viewer.user.id, body);
  if (channel.guild_id) requireChannelPerm(channel, viewer.user.id, Perm.MANAGE_CHANNELS);
  applyChannelFields(channel, body);
  if (typeof body.name === "string") {
    const keepCase = channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildCategory;
    channel.name = (keepCase ? body.name.trim() : body.name.trim().toLowerCase().replace(/\s+/g, "-")) || channel.name;
  }
  if ("topic" in body) channel.topic = str(body.topic)?.trim() || null;
  if (typeof body.position === "number") channel.position = body.position;
  if (channel.type === ChannelType.GuildVoice) {
    if (typeof body.bitrate === "number") channel.bitrate = body.bitrate;
    if (typeof body.user_limit === "number") channel.user_limit = body.user_limit;
  }
  const before = channel.guild_id ? visibilityOf(channel.guild_id) : null;
  if ("parent_id" in body) {
    const parent = str(body.parent_id) ?? null;
    const category = parent ? db.channels.get(parent) : undefined;
    if (parent && (!category || category.guild_id !== channel.guild_id || category.type !== ChannelType.GuildCategory)) fail(400, 50035, "Invalid Form Body", { parent_id: { code: "INVALID", message: "Unknown category" } });
    channel.parent_id = parent;
    // lock_permissions: true copies the new parent's overwrites; false/absent keeps the channel's own.
    if (body.lock_permissions === true && category) channel.permission_overwrites = (category.permission_overwrites ?? []).map(o => ({ ...o }));
  }
  const payload = channelFor(channel, viewer.user.id);
  if (channel.guild_id && before) emitVisibilityChanges(channel.guild_id, before, [channel.id]);
  else emit(channelAudience(channel), "CHANNEL_UPDATE", payload);
  return payload;
});

route("PUT", `/channels/${ID}/voice-status`, ({ viewer, params, body }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  setVoiceChannelStatus(viewer.user.id, channel, body.status, emit);
  return undefined;
});

route("DELETE", `/channels/${ID}`, ({ viewer, params }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  if (isThreadType(channel.type)) return deleteThread(channel, viewer.user.id);
  const payload = channelFor(channel, viewer.user.id);
  if (!channel.guild_id) {
    (channel.hidden_for ??= new Set()).add(viewer.user.id);
    emit([viewer.user.id], "CHANNEL_DELETE", payload);
    return payload;
  }
  requireChannelPerm(channel, viewer.user.id, Perm.MANAGE_CHANNELS);
  dropChannelExtras(channel);
  for (const id of channelAudience(channel)) emit([id], "CHANNEL_DELETE", channelFor(channel, id));
  eventsChannelRemoved(channel.id);
  purgeChannelRefs(channel.id);
  db.channels.delete(channel.id);
  db.messages.delete(channel.id);
  return payload;
});

// ---- invites ----

function invitePreview(code: string) {
  const invite = db.invites.get(code);
  const guild = invite && db.guilds.get(invite.guild_id);
  const channel = invite && db.channels.get(invite.channel_id);
  if (!invite || !guild || !channel) fail(404, 10006, "Unknown Invite");
  return {
    code,
    guild: { id: guild.guild.id, name: guild.guild.name, icon: guild.guild.icon },
    channel: { id: channel.id, name: channel.name },
    expires_at: invite.expires_at,
    member_count: guild.members.size,
  };
}

route("POST", `/channels/${ID}/invites`, ({ viewer, params, body }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  if (!channel.guild_id) fail(400, 50003, "Cannot execute action on a DM channel");
  requireChannelPerm(channel, viewer.user.id, Perm.CREATE_INSTANT_INVITE);
  const maxAge = typeof body.max_age === "number" ? body.max_age : 86_400;
  const code = Math.random().toString(36).slice(2, 10);
  db.invites.set(code, { code, guild_id: channel.guild_id, channel_id: channel.id, expires_at: maxAge > 0 ? new Date(Date.now() + maxAge * 1000).toISOString() : null });
  return invitePreview(code);
});

route("GET", "/invites/([a-z0-9]+)", ({ params }) => invitePreview(params[0] ?? ""));

route("POST", "/invites/([a-z0-9]+)", ({ viewer, params }) => {
  const preview = invitePreview(params[0] ?? "");
  const guild = db.guilds.get(preview.guild.id);
  if (!guild) fail(404, 10006, "Unknown Invite");
  if (db.bans.get(guild.guild.id)?.has(viewer.user.id)) fail(403, 40007, "The user is banned from this guild");
  if (!guild.members.has(viewer.user.id)) {
    const member = { nick: null, roles: [], joined_at: new Date().toISOString() };
    guild.members.set(viewer.user.id, member);
    onboardingStartedFor(guild.guild.id, viewer.user.id);
    emit([viewer.user.id], "GUILD_CREATE", guildPayload(guild.guild.id, viewer.user.id));
    emit([...guild.members.keys()].filter(id => id !== viewer.user.id), "GUILD_MEMBER_ADD", { guild_id: guild.guild.id, user: viewer.user, ...member, ...flagsField(guild.guild.id, viewer.user.id) });
  }
  return guild.guild;
});

// ---- messages ----

route("GET", `/channels/${ID}/messages`, ({ viewer, params, query }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  requireChannelPerm(channel, viewer.user.id, Perm.READ_MESSAGE_HISTORY, 50001, "Missing Access");
  const all = sortedMessages(channel.id);
  const limit = Math.min(100, Math.max(1, Number(query.get("limit") ?? 50) || 50));
  const before = query.get("before");
  const after = query.get("after");
  const around = query.get("around");
  let slice: typeof all;
  if (around) {
    const index = all.findIndex(m => compareIds(m.id, around) >= 0);
    const center = index === -1 ? all.length : index;
    const start = Math.max(0, center - Math.floor(limit / 2));
    slice = all.slice(start, start + limit);
  } else if (after) {
    slice = all.filter(m => compareIds(m.id, after) > 0).slice(0, limit);
  } else if (before) {
    slice = all.filter(m => compareIds(m.id, before) < 0).slice(-limit);
  } else {
    slice = all.slice(-limit);
  }
  return slice.map(m => messageFor(m, viewer.user.id)).reverse();
});

route("POST", `/channels/${ID}/messages`, ({ viewer, params, body }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  assertCanPost(channel, viewer.user.id);
  requireChannelPerm(channel, viewer.user.id, Perm.SEND_MESSAGES);
  const content = (str(body.content) ?? "").trim();
  // `attachments` (id + optional rename / alt text) replaces `attachment_ids`; a "SPOILER_" filename prefix marks a spoiler.
  const metas = Array.isArray(body.attachments)
    ? body.attachments.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string")
    : (Array.isArray(body.attachment_ids) ? body.attachment_ids.filter((v): v is string => typeof v === "string") : []).map(id => ({ id }) as Record<string, unknown>);
  const ids = metas.map(m => String(m.id));
  if (ids.length > 10) fail(400, 50035, "Invalid Form Body", { attachment_ids: { code: "BASE_TYPE_BAD_LENGTH", message: "Must be 10 or fewer in length." } });
  const attachments = metas.map(meta => {
    const found = pendingAttachment(String(meta.id), viewer.user.id);
    if (!found) return null;
    const filename = str(meta.filename)?.trim();
    const description = str(meta.description);
    if (filename !== undefined && (filename === "" || filename.length > 255)) fail(400, 50035, "Invalid Form Body", { attachments: { code: "BASE_TYPE_BAD_LENGTH", message: "Filename must be 1 to 255 characters." } });
    if (description !== undefined && description.length > 1024) fail(400, 50035, "Invalid Form Body", { attachments: { code: "BASE_TYPE_MAX_LENGTH", message: "Description must be 1024 or fewer in length." } });
    return { ...found, ...(filename !== undefined ? { filename } : {}), ...(description !== undefined ? { description: description === "" ? null : description } : {}) };
  }).filter((a): a is Attachment => a !== null);
  if (content.length > 2000) fail(400, 50035, "Invalid Form Body", { content: { code: "BASE_TYPE_MAX_LENGTH", message: "Must be 2000 or fewer in length." } });
  const reference = body.message_reference as { message_id?: string; channel_id?: string; type?: number } | undefined;
  const forwarding = reference?.type === 1;
  const stickers = resolveStickers(channel, viewer.user.id, body.sticker_ids);
  if (forwarding && (content !== "" || attachments.length > 0 || stickers.length > 0)) fail(400, 50035, "Invalid Form Body", { message_reference: { code: "FORWARD_HAS_CONTENT", message: "A forward cannot carry content, attachments or stickers." } });
  if (content === "" && attachments.length === 0 && stickers.length === 0 && !forwarding) fail(400, 50035, "Invalid Form Body", { content: { code: "BASE_TYPE_REQUIRED", message: "This field is required" } });
  const forward = forwarding ? buildForward(viewer.user.id, reference, channel) : undefined;
  if (reference?.message_id && !forwarding) requireMessage(channel.id, reference.message_id);
  for (const id of ids) db.pending.delete(id);
  const message = addMessage({
    channel,
    author_id: viewer.user.id,
    content,
    attachments,
    stickers,
    forward,
    reference_id: forwarding ? null : reference?.message_id ?? null,
    nonce: str(body.nonce) ?? null,
    allowEveryone: hasBit(channelPermsOf(channel, viewer.user.id), Perm.MENTION_EVERYONE),
  });
  return messageFor(message, viewer.user.id);
});

route("PATCH", `/channels/${ID}/messages/${ID}`, ({ viewer, params, body }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  const message = requireMessage(channel.id, params[1] ?? "");
  if (message.author_id !== viewer.user.id) fail(403, 50005, "Cannot edit a message authored by another user");
  assertThreadOpen(channel);
  // `content` is optional now; `attachments` lists the ones to keep (omitted = unchanged, can only remove).
  const content = (str(body.content) ?? message.content).trim();
  if (content.length > 2000) fail(400, 50035, "Invalid Form Body", { content: { code: "BASE_TYPE_MAX_LENGTH", message: "Must be 2000 or fewer in length." } });
  let attachments = message.attachments;
  if (Array.isArray(body.attachments)) {
    const keep = new Set(body.attachments.map(a => (typeof a === "object" && a !== null ? str((a as { id?: unknown }).id) : undefined)).filter((id): id is string => id !== undefined));
    attachments = message.attachments.filter(a => keep.has(a.id));
  }
  if (content === "" && attachments.length === 0) fail(400, 50006, "Cannot send an empty message");
  message.content = content;
  message.attachments = attachments;
  message.edited_timestamp = new Date().toISOString();
  message.mention_ids = [...new Set([...content.matchAll(/<@!?(\d+)>/g)].map(m => m[1] ?? "").filter(id => db.accounts.has(id)))];
  message.mention_everyone = /(^|\s)@(everyone|here)\b/.test(content) && hasBit(channelPermsOf(channel, viewer.user.id), Perm.MENTION_EVERYONE);
  for (const id of channelAudience(channel)) emit([id], "MESSAGE_UPDATE", messageFor(message, id));
  return messageFor(message, viewer.user.id);
});

route("DELETE", `/channels/${ID}/messages/${ID}`, ({ viewer, params }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  const message = requireMessage(channel.id, params[1] ?? "");
  if (message.author_id !== viewer.user.id) requireChannelPerm(channel, viewer.user.id, Perm.MANAGE_MESSAGES);
  const list = sortedMessages(channel.id);
  list.splice(list.indexOf(message), 1);
  purgeMessageRefs(channel.id, message.id);
  channel.last_message_id = list.at(-1)?.id ?? null;
  emit(channelAudience(channel), "MESSAGE_DELETE", { id: message.id, channel_id: channel.id, guild_id: channel.guild_id });
  return undefined;
});

// ---- reactions ----

route("PUT", `/channels/${ID}/messages/${ID}/reactions/([^/]+)/@me`, ({ viewer, params }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  const message = requireMessage(channel.id, params[1] ?? "");
  requireChannelPerm(channel, viewer.user.id, Perm.ADD_REACTIONS);
  assertThreadOpen(channel);
  const emoji = parseEmoji(params[2] ?? "");
  let reaction = message.reactions.find(r => sameEmoji(r.emoji, emoji));
  if (!reaction) message.reactions.push((reaction = { emoji, user_ids: [] }));
  if (!reaction.user_ids.includes(viewer.user.id)) {
    reaction.user_ids.push(viewer.user.id);
    emit(channelAudience(channel), "MESSAGE_REACTION_ADD", { user_id: viewer.user.id, channel_id: channel.id, message_id: message.id, emoji });
  }
  return undefined;
});

route("DELETE", `/channels/${ID}/messages/${ID}/reactions/([^/]+)/@me`, ({ viewer, params }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  const message = requireMessage(channel.id, params[1] ?? "");
  const emoji = parseEmoji(params[2] ?? "");
  const reaction = message.reactions.find(r => sameEmoji(r.emoji, emoji));
  if (reaction?.user_ids.includes(viewer.user.id)) {
    reaction.user_ids = reaction.user_ids.filter(id => id !== viewer.user.id);
    if (reaction.user_ids.length === 0) message.reactions = message.reactions.filter(r => r !== reaction);
    emit(channelAudience(channel), "MESSAGE_REACTION_REMOVE", { user_id: viewer.user.id, channel_id: channel.id, message_id: message.id, emoji });
  }
  return undefined;
});

route("GET", `/channels/${ID}/messages/${ID}/reactions/([^/]+)`, ({ viewer, params }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  const message = requireMessage(channel.id, params[1] ?? "");
  const emoji = parseEmoji(params[2] ?? "");
  return (message.reactions.find(r => sameEmoji(r.emoji, emoji))?.user_ids ?? []).map((id): User => userOf(id));
});

// ---- pins, typing, ack ----

const MAX_PINS = 250;

function requirePinPerm(channel: MockChannel, viewerId: string): void {
  const bits = channelPermsOf(channel, viewerId);
  if (!hasBit(bits, Perm.PIN_MESSAGES) && !hasBit(bits, Perm.MANAGE_MESSAGES)) fail(403, 50013, "Missing Permissions");
}

route("GET", `/channels/${ID}/messages/pins`, ({ viewer, params, query }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  const limit = Math.min(50, Math.max(1, Number(query.get("limit") ?? 50) || 50));
  const before = query.get("before");
  const pinned = sortedMessages(channel.id)
    .filter(m => m.pinned && m.pinned_at)
    .sort((a, b) => Date.parse(b.pinned_at ?? "") - Date.parse(a.pinned_at ?? "") || compareIds(b.id, a.id))
    .filter(m => !before || Date.parse(m.pinned_at ?? "") < Date.parse(before));
  const page = pinned.slice(0, limit);
  return { items: page.map(m => ({ message: messageFor(m, viewer.user.id), pinned_at: m.pinned_at })), has_more: pinned.length > page.length };
});

route("PUT", `/channels/${ID}/messages/pins/${ID}`, ({ viewer, params }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  const message = requireMessage(channel.id, params[1] ?? "");
  requirePinPerm(channel, viewer.user.id);
  if (message.pinned) return undefined;
  if (sortedMessages(channel.id).filter(m => m.pinned).length >= MAX_PINS) fail(400, 30003, `Maximum number of pins reached (${MAX_PINS})`);
  message.pinned = true;
  message.pinned_at = new Date().toISOString();
  for (const id of channelAudience(channel)) emit([id], "MESSAGE_UPDATE", messageFor(message, id));
  addMessage({ channel, author_id: viewer.user.id, content: "", type: MessageType.ChannelPinnedMessage, reference_id: message.id });
  return undefined;
});

route("DELETE", `/channels/${ID}/messages/pins/${ID}`, ({ viewer, params }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  const message = requireMessage(channel.id, params[1] ?? "");
  requirePinPerm(channel, viewer.user.id);
  if (!message.pinned) return undefined;
  message.pinned = false;
  message.pinned_at = null;
  for (const id of channelAudience(channel)) emit([id], "MESSAGE_UPDATE", messageFor(message, id));
  return undefined;
});

route("POST", `/channels/${ID}/typing`, ({ viewer, params }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  requireChannelPerm(channel, viewer.user.id, Perm.SEND_MESSAGES);
  emit(
    channelAudience(channel).filter(id => id !== viewer.user.id),
    "TYPING_START",
    { channel_id: channel.id, user_id: viewer.user.id, timestamp: Math.floor(Date.now() / 1000) },
  );
  return undefined;
});

function ackChannel(viewer: MockAccount, channelId: string, messageId: string): void {
  const channel = requireChannel(channelId, viewer.user.id);
  const message = requireMessage(channel.id, messageId);
  const state = viewer.readStates.get(channel.id) ?? { channel_id: channel.id, last_message_id: null, mention_count: 0 };
  if (!state.last_message_id || compareIds(message.id, state.last_message_id) > 0) state.last_message_id = message.id;
  state.mention_count = 0;
  viewer.readStates.set(channel.id, state);
  emit([viewer.user.id], "MESSAGE_ACK", { channel_id: channel.id, message_id: state.last_message_id ?? message.id });
}

route("POST", `/channels/${ID}/messages/${ID}/ack`, ({ viewer, params }) => {
  ackChannel(viewer, params[0] ?? "", params[1] ?? "");
  return undefined;
});

route("POST", "/read-states/ack-bulk", ({ viewer, body }) => {
  const list = Array.isArray(body.read_states) ? (body.read_states as { channel_id?: unknown; message_id?: unknown }[]) : null;
  if (!list || list.length === 0 || list.length > 100) fail(400, 50035, "Invalid Form Body", { read_states: { code: "BASE_TYPE_BAD_LENGTH", message: "Must be between 1 and 100 in length." } });
  for (const entry of list) {
    const channelId = str(entry.channel_id);
    const messageId = str(entry.message_id);
    if (channelId && messageId) ackChannel(viewer, channelId, messageId);
  }
  return undefined;
});

// ---- entry point ----

const PUBLIC = new Set(["POST /auth/register", "POST /auth/login"]);
/** An invite preview is readable without an account (the invite page shows it before login). */
const isInvitePreview = (method: string, pathname: string): boolean => method === "GET" && /^\/invites\/[a-z0-9]+$/.test(pathname);

export function handleRoute(method: string, rawPath: string, body: unknown, viewerId: string | null): unknown {
  const url = new URL(rawPath, "http://mock.local");
  const key = `${method} ${url.pathname}`;
  const viewer = viewerId ? db.accounts.get(viewerId) : undefined;
  if (!viewer && !PUBLIC.has(key) && !url.pathname.startsWith("/auth/") && !isInvitePreview(method, url.pathname)) fail(401, 0, "401: Unauthorized");
  for (const r of routes) {
    if (r.method !== method) continue;
    const match = r.pattern.exec(url.pathname);
    if (!match) continue;
    const ctx = { viewer: viewer as MockAccount, params: match.slice(1), query: url.searchParams, body: (body && typeof body === "object" ? body : {}) as Record<string, unknown> };
    return r.handler(ctx);
  }
  return fail(404, 0, "404: Not Found");
}

