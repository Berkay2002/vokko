// Mock REST router: every route of docs/api.md that the UI uses, with the same status codes and error codes.

import { AuditLogEvent, ChannelType, ExplicitContentFilter, JoinSourceType, MessageFlags, MessageType, ReactionType, RelationshipType, VerificationLevel, isThreadType, type Attachment, type Channel, type Guild, type GuildMember, type Message, type ReactionEmoji, type Relationship, type User } from "../types";
import { compareIds } from "../snowflake";
import { Perm, hasBit } from "../permissions";
import { channelPermsOf } from "./access";
import { RateLimitedError, SLOWMODE_CODE } from "../errors";
import { db, nextId, sortedMessages, userOf, type MockAccount, type MockChannel } from "./db";
import { pendingAttachment, addChannel, addMessage, canAccess, channelAudience, createAccount, createGuildRecord, fail, openDM, openGroupDM, requireChannel, requireChannelPerm, requireGuildMember, requireGuildPerm, requireMessage, emitVisibilityChanges, visibilityOf } from "./ops";
import { buildForward, purgeChannelRefs, purgeGuildStickers, purgeMessageRefs, resolveStickers } from "./media";
import { parseOverwrites } from "./moderation";
import { applyChannelFields, assertCanPost, assertThreadOpen, deleteThread, dropChannelExtras, editThread, initChannelFields } from "./threads";
import { applyGuildPerks, applyUserPerks, dropTagOnLeave, memberProfileFields, parseWidgets } from "./perks";
import { ID, route, routes, str, withAuditReason } from "./router";
import { change, checkAutomod, checkSend, recordAudit } from "./admin";
import { emit } from "./socket";
import { checkRulesAccepted, onboardingStartedFor, eventsChannelRemoved } from "./community";
import { flagsField } from "./memberFlags";
import { setMockVoice, setVoiceChannelStatus, voiceStates } from "./voice";
import { callRecipientRemoved } from "./calls";
import { channelFor, guildPayload, membersOf, messageFor, privateChannelsFor, relationship, relationshipsFor, setRelationship } from "./views";
import { rememberImage } from "./avatars";
import "./search";
import "./membersSearch";
import { dismissEphemeral, mergeEphemerals } from "./apps";
import { mutualFriendsOf } from "./mutualFriends";
import { resolveReactionEmoji, sameReactionEmoji } from "./emojis";
import "./calls";
import "./watch";
import "./stremio";
import "./spotify";
import "./games";
import { parsePoll, requirePollPerm } from "./polls";
import { addPoll, isPoll } from "./pollData";
import "./invites";
import "./templates";
import "./guildSettings";
import "./stage";
import { assertAcceptsFriendRequest, assertCanOpenDm, assertDmOpen } from "./settings";
import "./community";
import "./status";
import "./soundboard";
import "./reports";
import { purgeGuildJoinRequests } from "./joinRequests";

export { route, str, requireGuildMember, parseEmoji };

/** Like the server's parse_emoji: `name:id` for a custom emoji, otherwise a unicode emoji; 400 50035 for anything else. */
function parseEmoji(raw: string): ReactionEmoji {
  const invalid = (): never => fail(400, 50035, "Invalid Form Body", { emoji: { code: "INVALID", message: "Unknown Emoji" } });
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return invalid();
  }
  const idx = decoded.indexOf(":");
  if (idx >= 0) {
    const name = decoded.slice(0, idx);
    const id = decoded.slice(idx + 1);
    if (!/^\d+$/.test(id) || BigInt(id) === 0n || BigInt(id) > 0x7fffffffffffffffn) return invalid();
    if (!/^[A-Za-z0-9_]{2,32}$/.test(name)) return invalid();
    return { id: BigInt(id).toString(), name };
  }
  const name = decoded.trim();
  if (name === "" || new TextEncoder().encode(name).length > 64 || (!KEYCAP.test(name) && /[A-Za-z0-9\p{Cc}\p{White_Space}]/u.test(name))) return invalid();
  return { id: null, name };
}

/** Like the server's is_keycap: `1️⃣`, `#️⃣`, `*️⃣` (0-9, # or *, optional U+FE0F, U+20E3), the only emoji with an ASCII digit; `1⃣` without U+FE0F too. */
const KEYCAP = /^[0-9#*]\uFE0F?\u20E3$/;

const sameEmoji = sameReactionEmoji;

// ---- auth ----


// ---- users ----

route("GET", "/users/@me", ({ viewer }) => viewer.user);

route("PATCH", "/users/@me", ({ viewer, body }) => {
  const user = viewer.user;
  // Validated before anything changes, so a rejected board leaves the other fields of the request alone too.
  const widgets = "widgets" in body ? parseWidgets(user, body.widgets) : undefined;
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
    if (attachment) rememberImage("avatar", user.id, attachment.id);
  }
  applyUserPerks(user, body, id => pendingAttachment(id, user.id));
  if ("banner_attachment_id" in body) {
    const attachment = pendingAttachment(str(body.banner_attachment_id), user.id);
    if (attachment) rememberImage("banner", user.id, attachment.id);
  }
  if (widgets !== undefined) user.widgets = widgets;
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

route("GET", `/users/${ID}/relationships`, ({ viewer, params }) => {
  const other = db.accounts.get(params[0] ?? "");
  if (!other) fail(404, 10013, "Unknown User");
  return mutualFriendsOf(viewer, other);
});

route("GET", `/users/${ID}/profile`, ({ viewer, params, query }) => {
  const other = db.accounts.get(params[0] ?? "");
  if (!other) fail(404, 10013, "Unknown User");
  const mutual_guilds = [...db.guilds.values()]
    .filter(g => g.members.has(viewer.user.id) && g.members.has(other.user.id))
    .map(g => ({ id: g.guild.id, nick: g.members.get(other.user.id)?.nick ?? null }));
  const mutual_friends_count = mutualFriendsOf(viewer, other).length;
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
    const existing = [...db.channels.values()].some(c => c.type === ChannelType.DM && c.participant_ids?.includes(viewer.user.id) && c.participant_ids.includes(recipient));
    if (!existing) assertCanOpenDm(viewer.user.id, recipient);
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
  if (!accept) assertAcceptsFriendRequest(viewerId, otherId);
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
  const before = { ...guild.guild };
  const level = body.verification_level;
  if (level !== undefined && (typeof level !== "number" || !Number.isInteger(level) || level < VerificationLevel.None || level > VerificationLevel.VeryHigh)) {
    fail(400, 50035, "Invalid Form Body", { verification_level: { code: "BASE_TYPE_CHOICES", message: "Value must be one of (0, 1, 2, 3, 4)." } });
  }
  const filter = body.explicit_content_filter;
  if (filter !== undefined && (typeof filter !== "number" || !Number.isInteger(filter) || filter < ExplicitContentFilter.Disabled || filter > ExplicitContentFilter.AllMembers)) {
    fail(400, 50035, "Invalid Form Body", { explicit_content_filter: { code: "BASE_TYPE_CHOICES", message: "Value must be one of (0, 1, 2)." } });
  }
  const nsfwLevel = body.nsfw_level;
  if (nsfwLevel !== undefined && nsfwLevel !== 0 && nsfwLevel !== 3) {
    fail(400, 50035, "Invalid Form Body", { nsfw_level: { code: "BASE_TYPE_CHOICES", message: "Value must be one of (0, 3)." } });
  }
  if ("rules_channel_id" in body && body.rules_channel_id !== null) {
    const rules = typeof body.rules_channel_id === "string" ? db.channels.get(body.rules_channel_id) : undefined;
    if (!rules || rules.guild_id !== guild.guild.id || rules.type !== ChannelType.GuildText) {
      fail(400, 50035, "Invalid Form Body", { rules_channel_id: { code: "CHANNEL_INVALID", message: "Must be a text channel of this server." } });
    }
  }
  if ("public_updates_channel_id" in body && body.public_updates_channel_id !== null) {
    const updates = typeof body.public_updates_channel_id === "string" ? db.channels.get(body.public_updates_channel_id) : undefined;
    if (!updates || updates.guild_id !== guild.guild.id || updates.type !== ChannelType.GuildText) {
      fail(400, 50035, "Invalid Form Body", { public_updates_channel_id: { code: "CHANNEL_INVALID", message: "Must be a text channel of this server." } });
    }
  }
  const features = body.features;
  if (features !== undefined && (!Array.isArray(features) || features.some(f => f !== "COMMUNITY"))) {
    fail(400, 50035, "Invalid Form Body", { features: { code: "BASE_TYPE_CHOICES", message: "Only COMMUNITY can be changed." } });
  }
  const community = Array.isArray(features) ? features.length > 0 : (guild.guild.features ?? []).includes("COMMUNITY");
  if (community && (features !== undefined || "rules_channel_id" in body || "public_updates_channel_id" in body || level !== undefined || filter !== undefined)) {
    const need = (key: string, message: string) => fail(400, 50035, "Invalid Form Body", { [key]: { code: "COMMUNITY_REQUIREMENT", message } });
    if (("rules_channel_id" in body ? body.rules_channel_id : guild.guild.rules_channel_id) == null) need("rules_channel_id", "A Community needs a rules channel.");
    if (("public_updates_channel_id" in body ? body.public_updates_channel_id : guild.guild.public_updates_channel_id) == null) need("public_updates_channel_id", "A Community needs a community updates channel.");
    if ((typeof level === "number" ? level : guild.guild.verification_level ?? 0) < VerificationLevel.Low) need("verification_level", "A Community needs a verification level of at least low.");
    if ((typeof filter === "number" ? filter : guild.guild.explicit_content_filter ?? 0) !== ExplicitContentFilter.AllMembers) need("explicit_content_filter", "A Community needs the content filter on for all members.");
  }
  if (body.join_mode !== undefined && body.join_mode !== 0 && body.join_mode !== 1) {
    fail(400, 50035, "Invalid Form Body", { join_mode: { code: "BASE_TYPE_CHOICES", message: "Value must be one of (0, 1)." } });
  }
  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  if (name !== undefined && (name.length < 2 || name.length > 100)) fail(400, 50035, "Invalid Form Body", { name: { code: "BASE_TYPE_BAD_LENGTH", message: "Must be between 2 and 100 in length." } });
  if (nsfwLevel !== undefined) guild.guild.nsfw_level = nsfwLevel;
  if (body.join_mode !== undefined) guild.guild.join_mode = body.join_mode;
  if (body.default_message_notifications === 0 || body.default_message_notifications === 1) guild.guild.default_message_notifications = body.default_message_notifications;
  if ("rules_channel_id" in body) guild.guild.rules_channel_id = body.rules_channel_id as string | null;
  if ("public_updates_channel_id" in body) guild.guild.public_updates_channel_id = body.public_updates_channel_id as string | null;
  if (Array.isArray(features)) guild.guild.features = features as string[];
  if (typeof level === "number") guild.guild.verification_level = level;
  if (typeof filter === "number") guild.guild.explicit_content_filter = filter;
  if (name !== undefined) guild.guild.name = name;
  if ("icon_attachment_id" in body) guild.guild.icon = pendingAttachment(str(body.icon_attachment_id), viewer.user.id)?.url ?? null;
  if ("banner_attachment_id" in body) guild.guild.banner = pendingAttachment(str(body.banner_attachment_id), viewer.user.id)?.url ?? null;
  if ("system_channel_id" in body) guild.guild.system_channel_id = str(body.system_channel_id) ?? null;
  applyGuildPerks(guild, body);
  emit(guild.members.keys(), "GUILD_UPDATE", { ...guild.guild });
  const after = guild.guild;
  recordAudit(after.id, viewer.user.id, AuditLogEvent.GuildUpdate, after.id, {
    changes: [
      change("name", before.name, after.name),
      change("icon", before.icon, after.icon),
      change("banner", before.banner ?? null, after.banner ?? null),
      change("system_channel_id", before.system_channel_id, after.system_channel_id),
      change("verification_level", before.verification_level ?? 0, after.verification_level ?? 0),
      change("explicit_content_filter", before.explicit_content_filter ?? 0, after.explicit_content_filter ?? 0),
      change("join_mode", before.join_mode ?? 0, after.join_mode ?? 0),
    ],
    skipIfUnchanged: true,
  });
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
  purgeGuildJoinRequests(guildId);
  return undefined;
});

route("GET", `/guilds/${ID}/channels`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  return [...db.channels.values()].filter(c => c.guild_id === guildId && !isThreadType(c.type) && canAccess(c, viewer.user.id)).map(c => channelFor(c, viewer.user.id));
});

// Same rule as the server's `channel_name` (routes/guilds.rs) and the client's `channelNameFor` (shell/channels.ts).
const channelNameFor = (type: number, name: string): string => (type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement || type === ChannelType.GuildForum ? name.trim().toLowerCase().replace(/\s+/g, "-") : name.trim());

route("POST", `/guilds/${ID}/channels`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  requireGuildPerm(guildId, viewer.user.id, Perm.MANAGE_CHANNELS);
  const type = body.type;
  const creatable = [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.GuildAnnouncement, ChannelType.GuildStage, ChannelType.GuildForum];
  if (typeof type !== "number" || !creatable.includes(type)) fail(400, 50035, "Invalid Form Body", { type: { code: "BASE_TYPE_CHOICES", message: "Value must be one of (0, 2, 4, 5, 13, 15)." } });
  const name = channelNameFor(type, str(body.name) ?? "");
  if (name.length < 1 || name.length > 100) fail(400, 50035, "Invalid Form Body", { name: { code: "BASE_TYPE_BAD_LENGTH", message: "Must be between 1 and 100 in length." } });
  const parent = str(body.parent_id) ?? null;
  if (parent && db.channels.get(parent)?.guild_id !== guildId) fail(400, 50035, "Invalid Form Body", { parent_id: { code: "INVALID", message: "Unknown category" } });
  const permission_overwrites = parseOverwrites(guildId, viewer.user.id, body.permission_overwrites);
  const explicit = body.permission_overwrites !== undefined && body.permission_overwrites !== null;
  const channel = addChannel(guildId, { name, type, parent_id: type === ChannelType.GuildCategory ? null : parent, topic: str(body.topic) ?? null, permission_overwrites: explicit ? permission_overwrites : undefined });
  initChannelFields(channel, body);
  if (body.nsfw === true && type !== ChannelType.GuildCategory && type !== ChannelType.GuildStage) channel.nsfw = true;
  for (const id of channelAudience(channel)) emit([id], "CHANNEL_CREATE", channelFor(channel, id));
  recordAudit(guildId, viewer.user.id, AuditLogEvent.ChannelCreate, channel.id, { changes: channelChanges(null, channel) });
  return channelFor(channel, viewer.user.id);
});

// Modify Guild Channel Positions: validate every entry, then apply them all; CHANNEL_UPDATE per changed channel.
route("PATCH", `/guilds/${ID}/channels`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  requireGuildPerm(guildId, viewer.user.id, Perm.MANAGE_CHANNELS);
  const entries = Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
  const invalid = (message: string) => fail(400, 50035, "Invalid Form Body", { _errors: { code: "INVALID", message } });
  if (entries.length === 0) invalid("At least one channel is required.");
  if (entries.length > 500) invalid("At most 500 channels per request.");
  if (new Set(entries.map(e => str(e.id))).size !== entries.length) invalid("A channel is listed twice.");
  const sameOverwrites = (a: MockChannel, b: MockChannel) => {
    const key = (c: MockChannel) => JSON.stringify((c.permission_overwrites ?? []).map(o => `${o.id}:${o.type}:${o.allow}:${o.deny}`).sort());
    return key(a) === key(b);
  };
  const plan = entries.map(entry => {
    const channel = db.channels.get(str(entry.id) ?? "");
    if (!channel || channel.guild_id !== guildId || isThreadType(channel.type)) return invalid("Unknown channel.");
    // Like the server: the channel must be visible, MANAGE_CHANNELS is checked per channel (an overwrite can deny it), and a
    // sync that changes the overwrites needs MANAGE_ROLES in the channel.
    if (!canAccess(channel, viewer.user.id)) fail(403, 50001, "Missing Access");
    requireChannelPerm(channel, viewer.user.id, Perm.MANAGE_CHANNELS);
    let parent: MockChannel | null | undefined;
    if ("parent_id" in entry) {
      const parentId = str(entry.parent_id) ?? null;
      parent = parentId && parentId !== "0" ? db.channels.get(parentId) : null;
      if (parent === undefined || (parent && (parent.guild_id !== guildId || parent.type !== ChannelType.GuildCategory))) return invalid("Unknown category.");
      if (parent && channel.type === ChannelType.GuildCategory) return invalid("Categories cannot be nested.");
      if (parent && !canAccess(parent, viewer.user.id)) fail(403, 50001, "Missing Access");
      if (entry.lock_permissions === true && parent && !sameOverwrites(channel, parent)) requireChannelPerm(channel, viewer.user.id, Perm.MANAGE_ROLES);
    }
    return { channel, position: typeof entry.position === "number" ? entry.position : undefined, parent, lock: entry.lock_permissions === true };
  });
  const before = visibilityOf(guildId);
  for (const { channel, position, parent, lock } of plan) {
    if (position !== undefined) channel.position = position;
    if (parent !== undefined) {
      channel.parent_id = parent?.id ?? null;
      if (lock && parent) channel.permission_overwrites = (parent.permission_overwrites ?? []).map(o => ({ ...o }));
    }
  }
  emitVisibilityChanges(guildId, before, plan.map(p => p.channel.id));
  return undefined;
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

function channelChanges(before: Channel | null, after: Channel | null) {
  return (["name", "type", "topic", "position", "parent_id"] as const).map(key => change(key, before?.[key] ?? null, after?.[key] ?? null));
}

route("PATCH", `/channels/${ID}`, ({ viewer, params, body }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  if (isThreadType(channel.type) && typeof body.nsfw === "boolean") fail(400, 50035, "Invalid Form Body", { nsfw: { code: "INVALID", message: "This channel type cannot be age-restricted." } });
  if (isThreadType(channel.type)) return editThread(channel, viewer.user.id, body);
  if (channel.guild_id) requireChannelPerm(channel, viewer.user.id, Perm.MANAGE_CHANNELS);
  if ("icon_attachment_id" in body && channel.type !== ChannelType.GroupDM) fail(403, 50013, "Missing Permissions");
  // Group DMs (any recipient): the name as typed (empty clears it) and the icon, like the server.
  if (channel.type === ChannelType.GroupDM) {
    if (typeof body.name === "string") channel.name = body.name.trim() || null;
    if ("icon_attachment_id" in body) channel.icon = body.icon_attachment_id ? (pendingAttachment(str(body.icon_attachment_id), viewer.user.id)?.url ?? null) : null;
    const payload = channelFor(channel, viewer.user.id);
    emit(channelAudience(channel), "CHANNEL_UPDATE", payload);
    return payload;
  }
  const snapshot = { ...channel };
  applyChannelFields(channel, body);
  if (typeof body.name === "string") {
    channel.name = channelNameFor(channel.type, body.name) || channel.name;
  }
  if ("topic" in body) channel.topic = str(body.topic)?.trim() || null;
  if (typeof body.position === "number") channel.position = body.position;
  if (typeof body.nsfw === "boolean") {
    if (!channel.guild_id || channel.type === ChannelType.GuildCategory || channel.type === ChannelType.GuildStage) fail(400, 50035, "Invalid Form Body", { nsfw: { code: "INVALID", message: "This channel type cannot be age-restricted." } });
    channel.nsfw = body.nsfw;
  }
  if (channel.type === ChannelType.GuildVoice) {
    if (typeof body.bitrate === "number") channel.bitrate = body.bitrate;
    if (typeof body.user_limit === "number") channel.user_limit = body.user_limit;
  }
  if (typeof body.rate_limit_per_user === "number") {
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildVoice) fail(400, 50035, "Invalid Form Body", { rate_limit_per_user: { code: "INVALID", message: "Slowmode is only available in text and voice channels." } });
    if (body.rate_limit_per_user < 0 || body.rate_limit_per_user > 21600) fail(400, 50035, "Invalid Form Body", { rate_limit_per_user: { code: "INVALID", message: "Must be between 0 and 21600." } });
    channel.rate_limit_per_user = body.rate_limit_per_user;
  }
  const before = channel.guild_id ? visibilityOf(channel.guild_id) : null;
  if ("parent_id" in body) {
    const parent = str(body.parent_id) ?? null;
    const category = parent ? db.channels.get(parent) : undefined;
    if (parent && (!category || category.guild_id !== channel.guild_id || category.type !== ChannelType.GuildCategory)) fail(400, 50035, "Invalid Form Body", { parent_id: { code: "INVALID", message: "Unknown category" } });
    if (category && !canAccess(category, viewer.user.id)) fail(403, 50001, "Missing Access");
    channel.parent_id = parent;
    // lock_permissions: true copies the new parent's overwrites; false/absent keeps the channel's own.
    if (body.lock_permissions === true && category) channel.permission_overwrites = (category.permission_overwrites ?? []).map(o => ({ ...o }));
  }
  const payload = channelFor(channel, viewer.user.id);
  if (channel.guild_id && before) emitVisibilityChanges(channel.guild_id, before, [channel.id]);
  else emit(channelAudience(channel), "CHANNEL_UPDATE", payload);
  if (channel.guild_id) recordAudit(channel.guild_id, viewer.user.id, AuditLogEvent.ChannelUpdate, channel.id, { changes: channelChanges(snapshot, channel), skipIfUnchanged: true });
  return payload;
});

route("PUT", `/channels/${ID}/voice-status`, ({ viewer, params, body }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  setVoiceChannelStatus(viewer.user.id, channel, body.status, emit);
  return undefined;
});

route("PUT", `/channels/${ID}/recipients/${ID}`, ({ viewer, params }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  const target = params[1] ?? "";
  if (channel.type !== ChannelType.GroupDM) fail(400, 50024, "Cannot execute action on this channel type");
  const members = (channel.participant_ids ??= []);
  if (!db.accounts.has(target)) fail(404, 10013, "Unknown User");
  if (members.includes(target)) return undefined;
  if (relationship(viewer.user.id, target)?.type !== RelationshipType.Friend) fail(403, 50007, "Cannot send messages to this user");
  if (members.length >= 10) fail(400, 30004, "Maximum number of group DM recipients reached (10)");
  members.push(target);
  for (const id of members) {
    if (id === target) emit([id], "CHANNEL_CREATE", channelFor(channel, id));
    else emit([id], "CHANNEL_RECIPIENT_ADD", { channel_id: channel.id, user: userOf(target) });
  }
  return undefined;
});

route("DELETE", `/channels/${ID}/recipients/${ID}`, ({ viewer, params }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  const target = params[1] ?? "";
  if (channel.type !== ChannelType.GroupDM) fail(400, 50024, "Cannot execute action on this channel type");
  if (target !== viewer.user.id && channel.owner_id !== viewer.user.id) fail(403, 50013, "You lack permissions to perform that action");
  const members = channel.participant_ids ?? [];
  if (!members.includes(target)) return undefined;
  if (voiceStates.get(target)?.channel_id === channel.id) setMockVoice(target, null, emit);
  callRecipientRemoved(channel.id, target);
  const payload = channelFor(channel, target);
  channel.participant_ids = members.filter(id => id !== target);
  if (channel.owner_id === target) channel.owner_id = channel.participant_ids[0] ?? null;
  for (const id of channel.participant_ids) emit([id], "CHANNEL_RECIPIENT_REMOVE", { channel_id: channel.id, user: userOf(target) });
  emit([target], "CHANNEL_DELETE", payload);
  return undefined;
});

route("DELETE", `/channels/${ID}`, ({ viewer, params }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  if (isThreadType(channel.type)) return deleteThread(channel, viewer.user.id);
  const payload = channelFor(channel, viewer.user.id);
  if (!channel.guild_id) {
    (channel.hidden_for ??= new Set()).add(viewer.user.id);
    if (channel.type === ChannelType.GroupDM) {
      // Leaving a group DM also leaves its call and stops ringing that user.
      if (voiceStates.get(viewer.user.id)?.channel_id === channel.id) setMockVoice(viewer.user.id, null, emit);
      callRecipientRemoved(channel.id, viewer.user.id);
    }
    emit([viewer.user.id], "CHANNEL_DELETE", payload);
    return payload;
  }
  requireChannelPerm(channel, viewer.user.id, Perm.MANAGE_CHANNELS);
  recordAudit(channel.guild_id, viewer.user.id, AuditLogEvent.ChannelDelete, channel.id, { changes: channelChanges(channel, null) });
  dropChannelExtras(channel);
  for (const id of channelAudience(channel)) emit([id], "CHANNEL_DELETE", channelFor(channel, id));
  eventsChannelRemoved(channel.id);
  purgeChannelRefs(channel.id);
  db.channels.delete(channel.id);
  db.messages.delete(channel.id);
  const owner = db.guilds.get(channel.guild_id);
  if (owner && (owner.guild.rules_channel_id === channel.id || owner.guild.public_updates_channel_id === channel.id)) {
    if (owner.guild.rules_channel_id === channel.id) owner.guild.rules_channel_id = null;
    if (owner.guild.public_updates_channel_id === channel.id) owner.guild.public_updates_channel_id = null;
    emit(owner.members.keys(), "GUILD_UPDATE", { ...owner.guild });
  }
  return payload;
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
  return mergeEphemerals(channel.id, viewer.user.id, slice.map(m => messageFor(m, viewer.user.id)).reverse(), limit, slice.length >= limit);
});

/** `${channel}:${user}` → when they last sent in a slowmode channel (ms). */
const slowmodeSends = new Map<string, number>();

/** Like the server: one message per rate_limit_per_user seconds unless BYPASS_SLOWMODE, MANAGE_MESSAGES or MANAGE_CHANNELS (429 / 20016). */
function checkSlowmode(channel: MockChannel, userId: string): void {
  const seconds = channel.rate_limit_per_user ?? 0;
  if (seconds <= 0) return;
  const perms = channelPermsOf(channel, userId);
  if (hasBit(perms, Perm.BYPASS_SLOWMODE) || hasBit(perms, Perm.MANAGE_MESSAGES) || hasBit(perms, Perm.MANAGE_CHANNELS)) return;
  const key = `${channel.id}:${userId}`;
  const now = Date.now();
  const left = (slowmodeSends.get(key) ?? 0) + seconds * 1000 - now;
  if (left > 0) throw new RateLimitedError(left / 1000, false, "This action cannot be performed due to slowmode rate limit", SLOWMODE_CODE);
  slowmodeSends.set(key, now);
}

route("POST", `/channels/${ID}/messages`, ({ viewer, params, body }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  assertCanPost(channel, viewer.user.id);
  requireChannelPerm(channel, viewer.user.id, Perm.SEND_MESSAGES);
  // Like the server's create_message: the DM rule (403) comes before any body validation (400).
  assertDmOpen(channel, viewer.user.id);
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
  checkSlowmode(channel, viewer.user.id);
  if (body.poll !== undefined) {
    requirePollPerm(channel, viewer.user.id);
    if (ids.length > 0) fail(400, 50035, "Invalid Form Body", { attachments: { code: "BASE_TYPE_BAD_LENGTH", message: "A poll message cannot have attachments." } });
  }
  const reference = body.message_reference as { message_id?: string; channel_id?: string; type?: number } | undefined;
  const forwarding = reference?.type === 1;
  const stickers = resolveStickers(channel, viewer.user.id, body.sticker_ids);
  if (body.poll !== undefined && (forwarding || stickers.length > 0)) fail(400, 50035, "Invalid Form Body", { poll: { code: "BASE_TYPE_BAD_LENGTH", message: "A poll message cannot carry stickers or be a forward." } });
  const poll = body.poll !== undefined ? parsePoll(body.poll) : null;
  if (forwarding && (content !== "" || attachments.length > 0 || stickers.length > 0)) fail(400, 50035, "Invalid Form Body", { message_reference: { code: "FORWARD_HAS_CONTENT", message: "A forward cannot carry content, attachments or stickers." } });
  const voice = ((Number(body.flags) || 0) & MessageFlags.IsVoiceMessage) !== 0;
  if (voice) checkVoiceMessage(channel, viewer.user.id, { content, attachments, metas, stickers: stickers.length, poll: body.poll !== undefined });
  if (content === "" && attachments.length === 0 && stickers.length === 0 && !forwarding && !poll) fail(400, 50035, "Invalid Form Body", { content: { code: "BASE_TYPE_REQUIRED", message: "This field is required" } });
  const forward = forwarding ? buildForward(viewer.user.id, reference, channel) : undefined;
  if (reference?.message_id && !forwarding) requireMessage(channel.id, reference.message_id);
  checkRulesAccepted(channel.guild_id, viewer.user.id);
  checkSend(channel, viewer.user.id, content);
  for (const id of ids) db.pending.delete(id);
  // A poll is registered under the message's id first, so MESSAGE_CREATE already carries it.
  const messageId = poll ? nextId() : undefined;
  if (poll && messageId) addPoll(messageId, poll);
  const message = addMessage({
    ...(messageId ? { id: messageId } : {}),
    channel,
    author_id: viewer.user.id,
    content,
    attachments,
    stickers,
    forward,
    reference_id: forwarding ? null : reference?.message_id ?? null,
    nonce: str(body.nonce) ?? null,
    allowEveryone: hasBit(channelPermsOf(channel, viewer.user.id), Perm.MENTION_EVERYONE),
    // Without SEND_TTS_MESSAGES the flag is dropped and the message is still sent (the server does the same).
    tts: body.tts === true && hasBit(channelPermsOf(channel, viewer.user.id), Perm.SEND_TTS_MESSAGES),
    ...(voice ? { flags: MessageFlags.IsVoiceMessage } : {}),
  });
  return messageFor(message, viewer.user.id);
});

const VOICE_TYPES = ["audio/ogg", "audio/webm", "audio/mp4", "audio/aac"];

/** The server's voice-message rules (docs/api.md "Voice messages"); fills the attachment's duration_secs and waveform. */
function checkVoiceMessage(channel: MockChannel, userId: string, m: { content: string; attachments: Attachment[]; metas: Record<string, unknown>[]; stickers: number; poll: boolean }): void {
  requireChannelPerm(channel, userId, Perm.SEND_VOICE_MESSAGES);
  const invalid = (field: string, message: string): never => fail(400, 50035, "Invalid Form Body", { [field]: { code: "VOICE_MESSAGE_INVALID", message } });
  const [attachment] = m.attachments;
  if (m.attachments.length !== 1 || !attachment) invalid("attachments", "A voice message has exactly one audio attachment.");
  if (m.content !== "" || m.stickers > 0 || m.poll) invalid("flags", "A voice message cannot carry content, stickers or a poll.");
  const meta = m.metas[0] ?? {};
  const duration = typeof meta.duration_secs === "number" ? meta.duration_secs : NaN;
  const waveform = str(meta.waveform) ?? "";
  if (!(duration > 0 && duration <= 1200)) invalid("attachments", "duration_secs must be between 0 and 1200.");
  let samples = 0;
  try { samples = waveform.length <= 344 ? atob(waveform).length : 0; } catch { samples = 0; }
  if (samples < 1 || samples > 256) invalid("attachments", "waveform must be base64 of 1 to 256 samples.");
  if (!VOICE_TYPES.includes((attachment!.content_type ?? "").split(";")[0]!.trim())) invalid("attachments", "A voice message must be ogg/opus, webm/opus or mp4/aac audio.");
  m.attachments[0] = { ...attachment!, duration_secs: duration, waveform };
}

route("PATCH", `/channels/${ID}/messages/${ID}`, ({ viewer, params, body }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  const message = requireMessage(channel.id, params[1] ?? "");
  if (message.author_id !== viewer.user.id) fail(403, 50005, "Cannot edit a message authored by another user");
  checkRulesAccepted(channel.guild_id, viewer.user.id);
// The AutoMod alert carries the flagged member as author; like the server, system messages can't be edited.
  if (message.type === MessageType.AutoModerationAction) fail(400, 50035, "Invalid Form Body", { message_id: { code: "BASE_TYPE_INVALID", message: "Cannot edit a system message." } });
  assertThreadOpen(channel);
  if (isPoll(message.id)) fail(400, 520003, "Cannot edit a poll message");
  if (((message.flags ?? 0) & MessageFlags.IsVoiceMessage) !== 0) fail(400, 50035, "Invalid Form Body", { message_id: { code: "VOICE_MESSAGE_EDIT", message: "Cannot edit a voice message." } });
  // `content` is optional now; `attachments` lists the ones to keep (omitted = unchanged, can only remove).
  const content = (str(body.content) ?? message.content).trim();
  if (content.length > 2000) fail(400, 50035, "Invalid Form Body", { content: { code: "BASE_TYPE_MAX_LENGTH", message: "Must be 2000 or fewer in length." } });
  let attachments = message.attachments;
  if (Array.isArray(body.attachments)) {
    const keep = new Set(body.attachments.map(a => (typeof a === "object" && a !== null ? str((a as { id?: unknown }).id) : undefined)).filter((id): id is string => id !== undefined));
    attachments = message.attachments.filter(a => keep.has(a.id));
  }
  if (content === "" && attachments.length === 0) fail(400, 50006, "Cannot send an empty message");
  if (content !== message.content) checkAutomod(channel, viewer.user.id, content, true);
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
  if (dismissEphemeral(channel.id, params[1] ?? "", viewer.user.id)) return undefined;
  const message = requireMessage(channel.id, params[1] ?? "");
  if (message.author_id !== viewer.user.id || message.type === MessageType.AutoModerationAction) requireChannelPerm(channel, viewer.user.id, Perm.MANAGE_MESSAGES);
  const list = sortedMessages(channel.id);
  list.splice(list.indexOf(message), 1);
  purgeMessageRefs(channel.id, message.id);
  channel.last_message_id = list.at(-1)?.id ?? null;
  emit(channelAudience(channel), "MESSAGE_DELETE", { id: message.id, channel_id: channel.id, guild_id: channel.guild_id });
  if (channel.guild_id && message.author_id !== viewer.user.id) {
    recordAudit(channel.guild_id, viewer.user.id, AuditLogEvent.MessageDelete, message.author_id, { options: { channel_id: channel.id, count: "1" } });
  }
  return undefined;
});

// ---- reactions ----

/** `?type=0|1` (absent = 0): normal or burst (super) reaction. Vokko has no burst limit. */
function reactionBurst(query: URLSearchParams): boolean {
  const raw = query.get("type");
  if (raw === null || raw === "0") return false;
  if (raw === "1") return true;
  return fail(400, 50035, "Invalid Form Body", { type: { code: "BASE_TYPE_BAD_FORMAT", message: "Must be 0 (normal) or 1 (burst)." } });
}

const reactionEvent = (userId: string, channelId: string, messageId: string, emoji: ReactionEmoji, burst: boolean) => ({
  user_id: userId, channel_id: channelId, message_id: messageId, emoji, type: burst ? ReactionType.Burst : ReactionType.Normal, burst,
});

// Same order as the server's add_reaction: emoji and type (400) before the channel and message (404), then
// permissions, the archived thread and the DM rule (403), and only then whether a custom emoji is usable.
route("PUT", `/channels/${ID}/messages/${ID}/reactions/([^/]+)/@me`, ({ viewer, params, query }) => {
  const parsed = parseEmoji(params[2] ?? "");
  const burst = reactionBurst(query);
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  const message = requireMessage(channel.id, params[1] ?? "");
  requireChannelPerm(channel, viewer.user.id, Perm.ADD_REACTIONS);
  assertThreadOpen(channel);
  assertDmOpen(channel, viewer.user.id);
  checkRulesAccepted(channel.guild_id, viewer.user.id);
  const emoji = resolveReactionEmoji(channel, viewer.user.id, parsed);
  let reaction = message.reactions.find(r => sameEmoji(r.emoji, emoji));
  if (!reaction) {
    if (message.reactions.length >= 20) fail(400, 30010, "Maximum number of reactions reached (20)");
    message.reactions.push((reaction = { emoji, user_ids: [] }));
  }
  const list = burst ? (reaction.burst_ids ??= []) : reaction.user_ids;
  if (!list.includes(viewer.user.id)) {
    list.push(viewer.user.id);
    emit(channelAudience(channel), "MESSAGE_REACTION_ADD", { ...reactionEvent(viewer.user.id, channel.id, message.id, emoji, burst), message_author_id: message.author_id });
  }
  return undefined;
});

route("DELETE", `/channels/${ID}/messages/${ID}/reactions/([^/]+)/@me`, ({ viewer, params, query }) => {
  const emoji = parseEmoji(params[2] ?? "");
  const burst = reactionBurst(query);
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  const message = requireMessage(channel.id, params[1] ?? "");
  const reaction = message.reactions.find(r => sameEmoji(r.emoji, emoji));
  const list = burst ? reaction?.burst_ids : reaction?.user_ids;
  if (reaction && list?.includes(viewer.user.id)) {
    if (burst) reaction.burst_ids = list.filter(id => id !== viewer.user.id);
    else reaction.user_ids = list.filter(id => id !== viewer.user.id);
    if (reaction.user_ids.length + (reaction.burst_ids?.length ?? 0) === 0) message.reactions = message.reactions.filter(r => r !== reaction);
    emit(channelAudience(channel), "MESSAGE_REACTION_REMOVE", reactionEvent(viewer.user.id, channel.id, message.id, { ...reaction.emoji }, burst));
  }
  return undefined;
});

route("GET", `/channels/${ID}/messages/${ID}/reactions/([^/]+)`, ({ viewer, params, query }) => {
  const emoji = parseEmoji(params[2] ?? "");
  const burst = reactionBurst(query);
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  const message = requireMessage(channel.id, params[1] ?? "");
  const reaction = message.reactions.find(r => sameEmoji(r.emoji, emoji));
  return ((burst ? reaction?.burst_ids : reaction?.user_ids) ?? []).map((id): User => userOf(id));
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
  // Same order as the server's pin_message: permission and the DM rule (403) before the message lookup (404).
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  requirePinPerm(channel, viewer.user.id);
  assertDmOpen(channel, viewer.user.id);
  const message = requireMessage(channel.id, params[1] ?? "");
  if (message.pinned) return undefined;
  if (sortedMessages(channel.id).filter(m => m.pinned).length >= MAX_PINS) fail(400, 30003, `Maximum number of pins reached (${MAX_PINS})`);
  message.pinned = true;
  message.pinned_at = new Date().toISOString();
  for (const id of channelAudience(channel)) emit([id], "MESSAGE_UPDATE", messageFor(message, id));
  addMessage({ channel, author_id: viewer.user.id, content: "", type: MessageType.ChannelPinnedMessage, reference_id: message.id });
  if (channel.guild_id) recordAudit(channel.guild_id, viewer.user.id, AuditLogEvent.MessagePin, message.author_id, { options: { channel_id: channel.id, message_id: message.id } });
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
  if (channel.guild_id) recordAudit(channel.guild_id, viewer.user.id, AuditLogEvent.MessageUnpin, message.author_id, { options: { channel_id: channel.id, message_id: message.id } });
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

const PUBLIC = new Set(["POST /auth/register", "POST /auth/login", "GET /status"]);
/** An invite preview is readable without an account (the invite page shows it before login). */
const isInvitePreview = (method: string, pathname: string): boolean => method === "GET" && /^\/invites\/[a-z0-9]+$/.test(pathname);

export function handleRoute(method: string, rawPath: string, body: unknown, viewerId: string | null, auditReason: string | null = null): unknown {
  const url = new URL(rawPath, "http://mock.local");
  const key = `${method} ${url.pathname}`;
  const viewer = viewerId ? db.accounts.get(viewerId) : undefined;
  // Webhook and interaction token URLs carry their own credential (mock/apps.ts).
  const tokenRoute = /^\/(interactions\/\d+\/[^/]+\/callback|webhooks\/\d+\/[^/]+(\/messages\/[^/]+)?)$/.test(url.pathname);
  if (!viewer && !tokenRoute && !PUBLIC.has(key) && !url.pathname.startsWith("/auth/") && !isInvitePreview(method, url.pathname)) fail(401, 0, "401: Unauthorized");
  for (const r of routes) {
    if (r.method !== method) continue;
    const match = r.pattern.exec(url.pathname);
    if (!match) continue;
    const ctx = { viewer: viewer as MockAccount, params: match.slice(1), query: url.searchParams, body: (body && typeof body === "object" ? body : {}) as Record<string, unknown> };
    return withAuditReason(auditReason, () => r.handler(ctx));
  }
  return fail(404, 0, "404: Not Found");
}

