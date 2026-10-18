// Mock of guild templates (docs/api.md "Server templates"): one per guild, a snapshot of settings, roles and channels.

import { Perm } from "../permissions";
import { ChannelType, OverwriteType, isThreadType, type Guild, type GuildTemplate, type Role, type TemplateGuild } from "../types";
import { db, nextId, userOf, type MockChannel } from "./db";
import { fail, pendingAttachment, requireGuildPerm } from "./ops";
import { ID, route, str } from "./router";
import { emit } from "./socket";
import { guildPayload } from "./views";

interface MockTemplate {
  code: string;
  guild_id: string;
  name: string;
  description: string | null;
  creator_id: string;
  usage_count: number;
  source: TemplateGuild;
  created_at: string;
  updated_at: string;
}

const templates = new Map<string, MockTemplate>();
const CODE = "([A-Za-z0-9]+)";
const KINDS = new Set([ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.GuildAnnouncement, ChannelType.GuildStage, ChannelType.GuildForum]);

const invalid = (field: string, message: string): never => fail(400, 50035, "Invalid Form Body", { [field]: { _errors: [{ code: "INVALID", message }] } });
const unknown = (): never => fail(404, 10057, "Unknown Guild Template");

/** The guild as a template sees it now; deterministic, so `is_dirty` is a JSON comparison. */
export function snapshotOf(guildId: string): TemplateGuild {
  const guild = db.guilds.get(guildId)?.guild;
  if (!guild) return fail(404, 10004, "Unknown Guild");
  const roles = [...guild.roles].sort((a, b) => Number(a.id !== guildId) - Number(b.id !== guildId) || a.position - b.position || a.id.localeCompare(b.id));
  const roleIds = new Map(roles.map((role, index) => [role.id, index]));
  const channels = [...db.channels.values()]
    .filter(c => c.guild_id === guildId && KINDS.has(c.type) && !isThreadType(c.type))
    .sort((a, b) => Number(a.type !== ChannelType.GuildCategory) - Number(b.type !== ChannelType.GuildCategory) || a.position - b.position || a.id.localeCompare(b.id));
  const channelIds = new Map(channels.map((channel, index) => [channel.id, index + 1]));
  return {
    name: guild.name,
    verification_level: guild.verification_level ?? 0,
    default_message_notifications: guild.default_message_notifications ?? 0,
    explicit_content_filter: guild.explicit_content_filter ?? 0,
    system_channel_id: channelIds.get(guild.system_channel_id ?? "") ?? null,
    roles: roles.map(role => ({
      id: roleIds.get(role.id) ?? 0,
      name: role.name,
      permissions: role.permissions,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      unicode_emoji: role.unicode_emoji ?? null,
    })),
    channels: channels.map(channel => ({
      id: channelIds.get(channel.id) ?? 0,
      type: channel.type,
      name: channel.name ?? "",
      position: channel.position,
      topic: channel.topic ?? null,
      bitrate: channel.bitrate ?? null,
      user_limit: channel.user_limit ?? null,
      nsfw: channel.nsfw ?? false,
      rate_limit_per_user: channel.rate_limit_per_user ?? 0,
      parent_id: channelIds.get(channel.parent_id ?? "") ?? null,
      permission_overwrites: (channel.permission_overwrites ?? [])
        .filter(o => o.type === OverwriteType.Role && roleIds.has(o.id))
        .map(o => ({ id: roleIds.get(o.id) ?? 0, type: OverwriteType.Role, allow: o.allow, deny: o.deny }))
        .sort((a, b) => a.id - b.id),
    })),
  };
}

/** `withDirty` only on manager routes: anyone else with the code would get a live view of whether the guild changed. */
function toApi(template: MockTemplate, withDirty = true): GuildTemplate {
  return {
    code: template.code,
    name: template.name,
    description: template.description,
    usage_count: template.usage_count,
    creator_id: template.creator_id,
    creator: db.accounts.has(template.creator_id) ? userOf(template.creator_id) : null,
    created_at: template.created_at,
    updated_at: template.updated_at,
    source_guild_id: template.guild_id,
    serialized_source_guild: template.source,
    is_dirty: withDirty && db.guilds.has(template.guild_id) ? JSON.stringify(snapshotOf(template.guild_id)) !== JSON.stringify(template.source) : null,
  };
}

function live(code: string): MockTemplate {
  const template = templates.get(code);
  if (!template || !db.guilds.has(template.guild_id)) return unknown();
  return template;
}

function managed(guildId: string, code: string, viewerId: string): MockTemplate {
  requireGuildPerm(guildId, viewerId, Perm.MANAGE_GUILD);
  const template = live(code);
  if (template.guild_id !== guildId) unknown();
  return template;
}

function nameOf(value: unknown): string {
  const name = (str(value) ?? "").trim();
  if (name.length < 1 || name.length > 100) invalid("name", "Must be between 1 and 100 in length.");
  return name;
}

function descriptionOf(value: unknown): string | null {
  const text = (str(value) ?? "").trim();
  if (text.length > 120) invalid("description", "Must be 120 or fewer in length.");
  return text || null;
}

function newCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 12 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

route("GET", `/guilds/${ID}/templates`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildPerm(guildId, viewer.user.id, Perm.MANAGE_GUILD);
  return [...templates.values()].filter(t => t.guild_id === guildId).map(t => toApi(t));
});

route("POST", `/guilds/${ID}/templates`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  requireGuildPerm(guildId, viewer.user.id, Perm.MANAGE_GUILD);
  const name = nameOf(body.name);
  const description = descriptionOf(body.description);
  if ([...templates.values()].some(t => t.guild_id === guildId)) fail(400, 30031, "A server template already exists for this server.");
  const now = new Date().toISOString();
  const template: MockTemplate = { code: newCode(), guild_id: guildId, name, description, creator_id: viewer.user.id, usage_count: 0, source: snapshotOf(guildId), created_at: now, updated_at: now };
  templates.set(template.code, template);
  return toApi(template);
});

route("PUT", `/guilds/${ID}/templates/${CODE}`, ({ viewer, params }) => {
  const template = managed(params[0] ?? "", params[1] ?? "", viewer.user.id);
  template.source = snapshotOf(template.guild_id);
  template.updated_at = new Date().toISOString();
  return toApi(template);
});

route("PATCH", `/guilds/${ID}/templates/${CODE}`, ({ viewer, params, body }) => {
  const template = managed(params[0] ?? "", params[1] ?? "", viewer.user.id);
  if (body.name !== undefined) template.name = nameOf(body.name);
  if ("description" in body) template.description = descriptionOf(body.description);
  return toApi(template);
});

route("DELETE", `/guilds/${ID}/templates/${CODE}`, ({ viewer, params }) => {
  const template = managed(params[0] ?? "", params[1] ?? "", viewer.user.id);
  templates.delete(template.code);
  return toApi(template);
});

route("GET", `/guilds/templates/${CODE}`, ({ params }) => toApi(live(params[0] ?? ""), false));

route("POST", `/guilds/templates/${CODE}`, ({ viewer, params, body }) => {
  const template = live(params[0] ?? "");
  const name = (str(body.name) ?? "").trim();
  if (name.length < 2 || name.length > 100) fail(400, 50035, "Invalid Form Body", { name: { code: "BASE_TYPE_BAD_LENGTH", message: "Must be between 2 and 100 in length." } });
  const icon = pendingAttachment(str(body.icon_attachment_id), viewer.user.id);
  const source = template.source;
  const id = nextId();
  const roleIds = new Map(source.roles.map(role => [role.id, role.id === 0 ? id : nextId()]));
  const roles: Role[] = source.roles.map((role, position) => ({
    id: roleIds.get(role.id) ?? id,
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    position,
    permissions: role.permissions,
    mentionable: role.mentionable,
    unicode_emoji: role.unicode_emoji,
  }));
  const channelIds = new Map(source.channels.map(channel => [channel.id, nextId()]));
  const systemChannel = source.system_channel_id === null ? null : (channelIds.get(source.system_channel_id) ?? null);
  const guild: Guild = {
    id,
    name,
    icon: icon?.url ?? null,
    owner_id: viewer.user.id,
    roles,
    system_channel_id: systemChannel,
    nsfw_level: 0,
    rules_channel_id: null,
    features: [],
    public_updates_channel_id: null,
    verification_level: source.verification_level,
    default_message_notifications: source.default_message_notifications,
    explicit_content_filter: source.explicit_content_filter,
  };
  db.guilds.set(id, { guild, members: new Map([[viewer.user.id, { nick: null, roles: [], joined_at: new Date().toISOString() }]]) });
  for (const channel of source.channels) {
    const made: MockChannel = {
      id: channelIds.get(channel.id) ?? nextId(),
      type: channel.type,
      guild_id: id,
      name: channel.name,
      topic: channel.topic,
      position: channel.position,
      parent_id: channel.parent_id === null ? null : (channelIds.get(channel.parent_id) ?? null),
      last_message_id: null,
      nsfw: channel.nsfw,
      rate_limit_per_user: channel.rate_limit_per_user,
      permission_overwrites: channel.permission_overwrites.map(o => ({ id: roleIds.get(o.id) ?? id, type: OverwriteType.Role, allow: o.allow, deny: o.deny })),
      ...(channel.bitrate !== null ? { bitrate: channel.bitrate } : {}),
      ...(channel.user_limit !== null ? { user_limit: channel.user_limit } : {}),
      ...(channel.type === ChannelType.GuildVoice ? { status: null } : {}),
    };
    db.channels.set(made.id, made);
  }
  template.usage_count += 1;
  emit([viewer.user.id], "GUILD_CREATE", guildPayload(id, viewer.user.id));
  return guild;
});
