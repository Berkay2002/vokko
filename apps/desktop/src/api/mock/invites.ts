// Mock of invites (create with settings, preview, accept, list, revoke, INVITE_CREATE/DELETE) and of the guild layout
// (GET/PATCH /users/@me/guild-layout, GUILD_LAYOUT_UPDATE), following docs/api.md "Invites and server folders".

import { Perm, hasBit } from "../permissions";
import { AuditLogEvent, ChannelType, JoinSourceType, MessageType, isThreadType, type GuildFolder, type Invite, type InviteMetadata, type GuildLayout } from "../types";
import { channelPermsOf, guildPermsOf } from "./access";
import { change, recordAudit } from "./admin";
import { db, userOf, type MockAccount, type MockGuild, type MockInvite } from "./db";
import { addMessage, fail, guildAudience, requireChannel, requireChannelPerm, requireGuildMember, requireGuildPerm } from "./ops";
import { onboardingStartedFor } from "./community";
import { flagsField } from "./memberFlags";
import { ID, route } from "./router";
import { emit } from "./socket";
import { guildPayload } from "./views";

const MAX_AGE = 604_800;
const MAX_USES = 100;
const CODE = "([a-z0-9]+)";

const invalid = (field: string, message: string): never => fail(400, 50035, "Invalid Form Body", { [field]: { _errors: [{ code: "INVALID", message }] } });

function isLive(invite: MockInvite, now = Date.now()): boolean {
  if (invite.expires_at && Date.parse(invite.expires_at) <= now) return false;
  const max = invite.max_uses ?? 0;
  return max === 0 || (invite.uses ?? 0) < max;
}

export function liveInvite(code: string): MockInvite {
  const invite = db.invites.get(code);
  if (!invite || !isLive(invite) || !db.guilds.has(invite.guild_id) || !db.channels.has(invite.channel_id)) fail(404, 10006, "Unknown Invite");
  return invite;
}

function previewOf(invite: MockInvite): Invite {
  const guild = db.guilds.get(invite.guild_id);
  const channel = db.channels.get(invite.channel_id);
  if (!guild || !channel) fail(404, 10006, "Unknown Invite");
  return {
    code: invite.code,
    guild: { id: guild.guild.id, name: guild.guild.name, icon: guild.guild.icon, member_count: guild.members.size, join_mode: guild.guild.join_mode ?? 0 },
    channel: { id: channel.id, name: channel.name },
    expires_at: invite.expires_at,
  };
}

function metadataOf(invite: MockInvite): InviteMetadata {
  const inviterId = invite.inviter_id ?? db.guilds.get(invite.guild_id)?.guild.owner_id;
  return {
    ...previewOf(invite),
    inviter: inviterId && db.accounts.has(inviterId) ? userOf(inviterId) : null,
    uses: invite.uses ?? 0,
    max_uses: invite.max_uses ?? 0,
    max_age: invite.max_age ?? 0,
    temporary: invite.temporary ?? false,
    created_at: invite.created_at ?? new Date(0).toISOString(),
  };
}

/** Members who may list the invite: MANAGE_GUILD, or MANAGE_CHANNELS on its channel. */
function inviteAudience(invite: MockInvite): string[] {
  const channel = db.channels.get(invite.channel_id);
  return guildAudience(invite.guild_id).filter(id => hasBit(guildPermsOf(invite.guild_id, id), Perm.MANAGE_GUILD) || (!!channel && hasBit(channelPermsOf(channel, id), Perm.MANAGE_CHANNELS)));
}

function bounded(value: unknown, fallback: number, max: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) return invalid(field, `Must be between 0 and ${max}.`);
  return value;
}

const byAge = (a: MockInvite, b: MockInvite) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.code.localeCompare(b.code);

route("POST", `/channels/${ID}/invites`, ({ viewer, params, body }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  if (!channel.guild_id) return invalid("channel_id", "Invites need a guild channel.");
  if (isThreadType(channel.type) || channel.type === ChannelType.GuildCategory) invalid("channel_id", "Invites need a text, voice, announcement or forum channel.");
  requireChannelPerm(channel, viewer.user.id, Perm.CREATE_INSTANT_INVITE);
  const maxAge = bounded(body.max_age, 86_400, MAX_AGE, "max_age");
  const maxUses = bounded(body.max_uses, 0, MAX_USES, "max_uses");
  const temporary = body.temporary === true;
  if (body.unique !== true) {
    const existing = [...db.invites.values()]
      .filter(i => i.channel_id === channel.id && i.inviter_id === viewer.user.id && (i.max_age ?? 0) === maxAge && (i.max_uses ?? 0) === maxUses && (i.temporary ?? false) === temporary && isLive(i))
      .sort(byAge)
      .pop();
    if (existing) return metadataOf(existing);
  }
  let code = Math.random().toString(36).slice(2, 10);
  while (db.invites.has(code)) code = Math.random().toString(36).slice(2, 10);
  const invite: MockInvite = {
    code,
    guild_id: channel.guild_id,
    channel_id: channel.id,
    expires_at: maxAge > 0 ? new Date(Date.now() + maxAge * 1000).toISOString() : null,
    inviter_id: viewer.user.id,
    uses: 0,
    max_uses: maxUses,
    max_age: maxAge,
    temporary,
    created_at: new Date().toISOString(),
  };
  db.invites.set(code, invite);
  recordAudit(channel.guild_id, viewer.user.id, AuditLogEvent.InviteCreate, code, {
    changes: [
      change("code", null, code),
      change("channel_id", null, channel.id),
      change("inviter_id", null, viewer.user.id),
      change("max_age", null, maxAge),
      change("max_uses", null, maxUses),
      change("temporary", null, temporary),
    ],
  });
  const created = metadataOf(invite);
  emit(inviteAudience(invite), "INVITE_CREATE", created);
  return created;
});

route("GET", `/channels/${ID}/invites`, ({ viewer, params }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  if (!channel.guild_id) fail(403, 50013, "Missing Permissions");
  requireChannelPerm(channel, viewer.user.id, Perm.MANAGE_CHANNELS);
  return [...db.invites.values()].filter(i => i.channel_id === channel.id && isLive(i)).sort(byAge).map(metadataOf);
});

route("GET", `/guilds/${ID}/invites`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildPerm(guildId, viewer.user.id, Perm.MANAGE_GUILD);
  return [...db.invites.values()].filter(i => i.guild_id === guildId && db.channels.has(i.channel_id) && isLive(i)).sort(byAge).map(metadataOf);
});

route("GET", `/invites/${CODE}`, ({ params }) => previewOf(liveInvite(params[0] ?? "")));

/** Adds the user the way an invite accept does (join source, onboarding flag, GUILD_CREATE/GUILD_MEMBER_ADD, join message); a request approval passes consume=false. */
export function joinViaInvite(guild: MockGuild, userId: string, invite: MockInvite | undefined, consume: boolean): void {
  const member = { nick: null, roles: [], joined_at: new Date().toISOString() };
  // The join source stays server side (members-search); the gateway event carries the plain member.
  const inviterId = invite?.inviter_id ?? guild.guild.owner_id;
  guild.members.set(userId, { ...member, source_invite_code: invite?.code ?? null, inviter_id: inviterId, join_source_type: JoinSourceType.Invite });
  if (invite && consume) invite.uses = (invite.uses ?? 0) + 1;
  // only an invite join is temporary: an approved application makes a permanent member, like the server
  if (consume && invite?.temporary) (guild.temporary ??= new Set()).add(userId);
  onboardingStartedFor(guild.guild.id, userId);
  emit([userId], "GUILD_CREATE", guildPayload(guild.guild.id, userId));
  emit([...guild.members.keys()].filter(id => id !== userId), "GUILD_MEMBER_ADD", { guild_id: guild.guild.id, user: userOf(userId), ...member, ...flagsField(guild.guild.id, userId) });
  // The real server posts a UserJoin row from the joiner in the system channel (routes/invites.rs post_join_message).
  const system = guild.guild.system_channel_id ? db.channels.get(guild.guild.system_channel_id) : undefined;
  if (system?.guild_id === guild.guild.id) addMessage({ channel: system, author_id: userId, content: "", type: MessageType.UserJoin });
}

route("POST", `/invites/${CODE}`, ({ viewer, params }) => {
  const invite = liveInvite(params[0] ?? "");
  const guild = db.guilds.get(invite.guild_id);
  if (!guild) return fail(404, 10006, "Unknown Invite");
  if (db.bans.get(guild.guild.id)?.has(viewer.user.id)) fail(403, 40007, "The user is banned from this guild");
  if (!guild.members.has(viewer.user.id)) {
    if (guild.guild.join_mode === 1) fail(403, 150009, "This server requires an application to join");
    joinViaInvite(guild, viewer.user.id, invite, true);
  } else if (!invite.temporary) {
    guild.temporary?.delete(viewer.user.id);
  }
  return guild.guild;
});

route("DELETE", `/invites/${CODE}`, ({ viewer, params }) => {
  const invite = liveInvite(params[0] ?? "");
  requireGuildMember(invite.guild_id, viewer.user.id);
  if (!hasBit(guildPermsOf(invite.guild_id, viewer.user.id), Perm.MANAGE_GUILD)) {
    const channel = requireChannel(invite.channel_id, viewer.user.id);
    requireChannelPerm(channel, viewer.user.id, Perm.MANAGE_CHANNELS);
  }
  const revoked = metadataOf(invite);
  const audience = inviteAudience(invite);
  db.invites.delete(invite.code);
  recordAudit(invite.guild_id, viewer.user.id, AuditLogEvent.InviteDelete, invite.code, {
    changes: [
      change("code", invite.code, null),
      change("channel_id", invite.channel_id, null),
      change("inviter_id", invite.inviter_id ?? null, null),
      change("uses", invite.uses ?? 0, null),
      change("max_age", invite.max_age ?? 0, null),
      change("max_uses", invite.max_uses ?? 0, null),
    ],
  });
  emit(audience, "INVITE_DELETE", { code: invite.code, guild_id: invite.guild_id, channel_id: invite.channel_id });
  return revoked;
});

// ---- guild layout (server folders and rail order) ----

const settingsOf = (account: MockAccount): GuildLayout => account.guildLayout ?? { guild_folders: [], guild_positions: [] };
const isId = (value: unknown): value is string => typeof value === "string" && /^\d{1,20}$/.test(value);

function cleanFolders(raw: unknown): GuildFolder[] {
  if (!Array.isArray(raw) || raw.length > 100) return invalid("guild_folders", "At most 100 folders.");
  const ids = new Set<string>();
  const guilds = new Set<string>();
  return raw.map((entry: unknown) => {
    const folder = (entry ?? {}) as Record<string, unknown>;
    if (!isId(folder.id) || ids.has(folder.id)) return invalid("guild_folders", "Folder ids must be unique snowflakes.");
    ids.add(folder.id);
    const name = typeof folder.name === "string" ? folder.name.trim() || null : null;
    if (name && [...name].length > 32) invalid("guild_folders", "Folder names are at most 32 characters.");
    const color = folder.color ?? null;
    if (color !== null && (typeof color !== "number" || !Number.isInteger(color) || color < 0 || color > 0xffffff)) invalid("guild_folders", "Folder colours are RGB ints.");
    const guildIds = folder.guild_ids;
    if (!Array.isArray(guildIds) || guildIds.length === 0 || guildIds.length > 200 || !guildIds.every(isId)) return invalid("guild_folders", "A folder holds 1-200 servers.");
    for (const id of guildIds) {
      if (guilds.has(id)) invalid("guild_folders", "A server can be in one folder only.");
      guilds.add(id);
      if (guilds.size > 1000) invalid("guild_folders", "At most 1000 servers in folders.");
    }
    return { id: folder.id, name, color: color as number | null, guild_ids: [...guildIds] };
  });
}

function cleanPositions(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 1000 || !raw.every(isId)) return invalid("guild_positions", "At most 1000 server ids.");
  if (new Set(raw).size !== raw.length) invalid("guild_positions", "No server can be listed twice.");
  return [...raw];
}

route("GET", "/users/@me/guild-layout", ({ viewer }) => settingsOf(viewer));

route("PATCH", "/users/@me/guild-layout", ({ viewer, body }) => {
  const folders = body.guild_folders === undefined ? undefined : cleanFolders(body.guild_folders);
  const positions = body.guild_positions === undefined ? undefined : cleanPositions(body.guild_positions);
  const current = settingsOf(viewer);
  viewer.guildLayout = { guild_folders: folders ?? current.guild_folders, guild_positions: positions ?? current.guild_positions };
  emit([viewer.user.id], "GUILD_LAYOUT_UPDATE", viewer.guildLayout);
  return viewer.guildLayout;
});
