// Mock applications, bots, application commands, interactions, ephemeral messages and webhooks: every route of docs/api.md "Apps"
// with the server's status codes and events. Bots cannot connect to the mock gateway, so a bot can register a handler here
// (`botHandlers`) that answers its interactions; the seeded "Echo" bot does that with the public callback and followup logic.

import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ButtonStyle,
  ChannelType,
  ComponentType,
  InteractionCallbackType,
  InteractionType,
  MessageFlags,
  MessageType,
  WebhookType,
  type Application,
  type ApplicationCommand,
  type ApplicationCommandOption,
  type ApplicationCommandOptionChoice,
  type GuildIntegration,
  type Interaction,
  type InteractionDataOption,
  type InteractionResolved,
  type Message,
  type MessageComponent,
  type MessageInteractionMetadata,
  type User,
  type Webhook,
} from "../types";
import { ALL_PERMISSIONS, Perm, hasBit, parseBits } from "../permissions";
import { compareIds } from "../snowflake";
import { channelPermsOf, guildPermsOf } from "./access";
import { db, nextId, sortedMessages, userOf, type MockChannel, type MockMessage } from "./db";
import { addMessage, channelAudience, createAccount, fail, guildAudience, requireChannel, requireGuildMember, requireGuildPerm, MISSING_PERMISSIONS } from "./ops";
import { ID, route, str, type Ctx } from "./router";
import { emit } from "./socket";
import { guildPayload, membersOf, messageFor } from "./views";

export interface MockApp {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  icon: string | null;
  bot_public: boolean;
  install_permissions: string;
  token: string;
}

interface MockInteraction {
  id: string;
  application_id: string;
  token: string;
  kind: InteractionType;
  user_id: string;
  channel_id: string;
  /** Null for component clicks, which name the clicked message in `message_id` instead. */
  command: ApplicationCommand | null;
  message_id?: string;
  target_id: string | null;
  nonce: string | null;
  created: number;
  responded: boolean;
  original: { id: string; ephemeral: boolean } | null;
}

interface MockWebhook {
  id: string;
  guild_id: string;
  channel_id: string;
  name: string;
  avatar: string | null;
  token: string;
  creator_id: string;
}

export const apps = {
  applications: new Map<string, MockApp>(),
  commands: new Map<string, ApplicationCommand>(),
  interactions: new Map<string, MockInteraction>(),
  webhooks: new Map<string, MockWebhook>(),
  /** message id → ephemeral message and the only user who sees it */
  ephemerals: new Map<string, { message: Message; recipient: string }>(),
  /** `${guildId}:${appId}` → who added the bot and its role */
  integrations: new Map<string, { added_by: string; role_id: string | null }>(),
};

/** Bots answering their interactions inside the mock (they cannot use the mock gateway). */
export const botHandlers = new Map<string, (interaction: Interaction) => void>();

const CALLBACK_WINDOW_MS = 3000;
const TOKEN_LIFETIME_MS = 15 * 60_000;

const randomToken = (bytes = 32): string => Array.from({ length: bytes }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("");

function invalid(field: string, message: string): never {
  return fail(400, 50035, "Invalid Form Body", { [field]: { _errors: [{ code: "INVALID", message }] } });
}

function viewerIsBot(ctx: Ctx): void {
  if (ctx.viewer.user.bot) fail(403, 20001, "Bots cannot use this endpoint");
}

export function applicationFor(app: MockApp): Application {
  return { id: app.id, name: app.name, description: app.description, icon: app.icon, owner_id: app.owner_id, bot: userOf(app.id), bot_public: app.bot_public, install_params: { permissions: app.install_permissions } };
}

function ownedApp(id: string, viewerId: string): MockApp {
  const app = apps.applications.get(id);
  if (!app || app.owner_id !== viewerId) fail(404, 10002, "Unknown Application");
  return app;
}

/** Creates an application and its bot user. */
export function createApplication(ownerId: string, name: string, description = "", id = nextId()): MockApp {
  const base = name.toLowerCase().replace(/[^a-z0-9_.]/g, "_").replace(/^_+|_+$/g, "").slice(0, 26) || "bot";
  const taken = (u: string) => [...db.accounts.values()].some(a => a.user.username === u);
  const username = taken(base) ? `${base}_${randomToken(2)}` : base;
  const account = createAccount({ id, username, global_name: name, password: randomToken() });
  account.user.bot = true;
  const app: MockApp = { id, owner_id: ownerId, name, description, icon: null, bot_public: true, install_permissions: "0", token: randomToken() };
  apps.applications.set(id, app);
  return app;
}

/** Adds the bot to a guild with a role holding `bits` (none: no role). Emits like the server. */
export function addBotToGuild(app: MockApp, guildId: string, addedBy: string, bits: bigint, silent = false): string | null {
  const guild = db.guilds.get(guildId);
  if (!guild) fail(404, 10004, "Unknown Guild");
  let roleId: string | null = null;
  if (bits !== 0n) {
    roleId = nextId();
    guild.guild.roles.push({ id: roleId, name: app.name, color: 0, hoist: false, position: 1, permissions: bits.toString(), mentionable: false });
  }
  guild.members.set(app.id, { nick: null, roles: roleId ? [roleId] : [], joined_at: new Date().toISOString() });
  apps.integrations.set(`${guildId}:${app.id}`, { added_by: addedBy, role_id: roleId });
  if (!silent) {
    const others = guildAudience(guildId).filter(id => id !== app.id);
    const role = roleId ? guild.guild.roles.find(r => r.id === roleId) : undefined;
    if (role) emit(others, "GUILD_ROLE_CREATE", { guild_id: guildId, role: { ...role } });
    emit([app.id], "GUILD_CREATE", guildPayload(guildId, app.id));
    const member = membersOf(guildId).find(m => m.user.id === app.id);
    if (member) emit(others, "GUILD_MEMBER_ADD", { ...member, guild_id: guildId });
  }
  return roleId;
}

/** A bot's role is managed: nobody assigns, removes, edits or deletes it (the server answers 400 50035). */
export function isManagedRole(guildId: string, roleId: string): boolean {
  for (const [key, integration] of apps.integrations) if (key.startsWith(`${guildId}:`) && integration.role_id === roleId) return true;
  return false;
}

function removeBotFromGuild(appId: string, guildId: string): void {
  const guild = db.guilds.get(guildId);
  if (!guild) return;
  if (guild.members.delete(appId)) {
    emit([appId], "GUILD_DELETE", { id: guildId });
    emit(guild.members.keys(), "GUILD_MEMBER_REMOVE", { guild_id: guildId, user: userOf(appId) });
  }
  dropIntegration(guildId, appId);
}

/** After a bot left a guild (removed, kicked or banned): its integration, role and guild commands go too. */
export function dropIntegration(guildId: string, appId: string): void {
  const guild = db.guilds.get(guildId);
  const integration = apps.integrations.get(`${guildId}:${appId}`);
  if (!guild || !integration) return;
  apps.integrations.delete(`${guildId}:${appId}`);
  if (integration.role_id) {
    guild.guild.roles = guild.guild.roles.filter(r => r.id !== integration.role_id);
    for (const member of guild.members.values()) member.roles = member.roles.filter(r => r !== integration.role_id);
    emit(guild.members.keys(), "GUILD_ROLE_DELETE", { guild_id: guildId, role_id: integration.role_id });
  }
  for (const [id, command] of apps.commands) if (command.application_id === appId && command.guild_id === guildId) apps.commands.delete(id);
}

// ---- applications ----

route("GET", "/applications", ctx => {
  viewerIsBot(ctx);
  return [...apps.applications.values()].filter(a => a.owner_id === ctx.viewer.user.id).map(applicationFor);
});

route("POST", "/applications", ctx => {
  viewerIsBot(ctx);
  const name = (str(ctx.body.name) ?? "").trim();
  if (name.length < 2 || name.length > 32) invalid("name", "Must be between 2 and 32 in length.");
  const description = (str(ctx.body.description) ?? "").trim();
  if (description.length > 400) invalid("description", "Must be 400 or fewer in length.");
  if ([...apps.applications.values()].filter(a => a.owner_id === ctx.viewer.user.id).length >= 25) fail(400, 30035, "Maximum number of applications reached (25)");
  const app = createApplication(ctx.viewer.user.id, name, description);
  return { ...applicationFor(app), token: app.token };
});

route("GET", `/applications/${ID}`, ctx => {
  viewerIsBot(ctx);
  return applicationFor(ownedApp(ctx.params[0] ?? "", ctx.viewer.user.id));
});

route("PATCH", `/applications/${ID}`, ctx => {
  viewerIsBot(ctx);
  const app = ownedApp(ctx.params[0] ?? "", ctx.viewer.user.id);
  const bot = userOf(app.id);
  if ("name" in ctx.body) {
    const name = (str(ctx.body.name) ?? "").trim();
    if (name.length < 2 || name.length > 32) invalid("name", "Must be between 2 and 32 in length.");
    app.name = name;
    bot.global_name = name;
  }
  if ("description" in ctx.body) app.description = (str(ctx.body.description) ?? "").trim().slice(0, 400);
  if (typeof ctx.body.bot_public === "boolean") app.bot_public = ctx.body.bot_public;
  const params = ctx.body.install_params as { permissions?: unknown } | undefined;
  if (params && typeof params.permissions === "string") {
    if (!/^\d+$/.test(params.permissions)) invalid("install_params.permissions", "Must be a decimal permission bitfield.");
    app.install_permissions = (parseBits(params.permissions) & ALL_PERMISSIONS).toString();
  }
  if ("icon_attachment_id" in ctx.body) {
    const pending = ctx.body.icon_attachment_id ? db.pending.get(String(ctx.body.icon_attachment_id)) : undefined;
    app.icon = pending?.attachment.url ?? null;
    bot.avatar = app.icon;
  }
  emit([...db.accounts.keys()], "USER_UPDATE", { ...bot });
  return applicationFor(app);
});

route("DELETE", `/applications/${ID}`, ctx => {
  viewerIsBot(ctx);
  const app = ownedApp(ctx.params[0] ?? "", ctx.viewer.user.id);
  for (const guild of db.guilds.values()) if (guild.members.has(app.id)) removeBotFromGuild(app.id, guild.guild.id);
  for (const [id, command] of apps.commands) if (command.application_id === app.id) apps.commands.delete(id);
  apps.applications.delete(app.id);
  return undefined;
});

route("POST", `/applications/${ID}/bot/reset`, ctx => {
  viewerIsBot(ctx);
  const app = ownedApp(ctx.params[0] ?? "", ctx.viewer.user.id);
  app.token = randomToken();
  return { token: app.token };
});

// ---- authorize ----

function addableApp(clientId: string | null, viewerId: string): MockApp {
  const app = clientId ? apps.applications.get(clientId) : undefined;
  if (!app || (!app.bot_public && app.owner_id !== viewerId)) fail(404, 10002, "Unknown Application");
  return app;
}

route("GET", "/oauth2/authorize", ctx => {
  viewerIsBot(ctx);
  const app = addableApp(ctx.query.get("client_id"), ctx.viewer.user.id);
  const requested = ctx.query.get("permissions") ?? app.install_permissions;
  if (!/^\d+$/.test(requested)) invalid("permissions", "Must be a decimal permission bitfield.");
  const guilds = [...db.guilds.values()]
    .filter(g => g.members.has(ctx.viewer.user.id) && !g.members.has(app.id))
    .map(g => ({ g, bits: guildPermsOf(g.guild.id, ctx.viewer.user.id) }))
    .filter(({ bits }) => hasBit(bits, Perm.MANAGE_GUILD))
    .map(({ g, bits }) => ({ id: g.guild.id, name: g.guild.name, icon: g.guild.icon, permissions: bits.toString() }));
  return { application: applicationFor(app), bot: userOf(app.id), permissions: (parseBits(requested) & ALL_PERMISSIONS).toString(), guilds };
});

route("POST", "/oauth2/authorize", ctx => {
  viewerIsBot(ctx);
  const app = addableApp(ctx.query.get("client_id"), ctx.viewer.user.id);
  const guildId = str(ctx.body.guild_id) ?? "";
  requireGuildPerm(guildId, ctx.viewer.user.id, Perm.MANAGE_GUILD);
  const guild = db.guilds.get(guildId);
  if (!guild) fail(404, 10004, "Unknown Guild");
  if (guild.members.has(app.id)) invalid("guild_id", "The bot is already a member of this server.");
  if (db.bans.get(guildId)?.has(app.id)) fail(403, 40007, "The user is banned from this guild");
  const raw = str(ctx.body.permissions) ?? ctx.query.get("permissions") ?? app.install_permissions;
  if (!/^\d+$/.test(raw)) invalid("permissions", "Must be a decimal permission bitfield.");
  const granted = parseBits(raw) & ALL_PERMISSIONS & guildPermsOf(guildId, ctx.viewer.user.id);
  const roleId = addBotToGuild(app, guildId, ctx.viewer.user.id, granted);
  return { guild_id: guildId, role_id: roleId };
});

route("GET", `/guilds/${ID}/integrations`, ctx => {
  const guildId = ctx.params[0] ?? "";
  requireGuildPerm(guildId, ctx.viewer.user.id, Perm.MANAGE_GUILD);
  const guild = db.guilds.get(guildId);
  const out: GuildIntegration[] = [];
  for (const [key, integration] of apps.integrations) {
    const [gid, appId] = key.split(":");
    const app = appId ? apps.applications.get(appId) : undefined;
    if (gid !== guildId || !app || !guild?.members.has(app.id)) continue;
    out.push({
      id: app.id,
      type: "bot",
      name: app.name,
      enabled: true,
      application: { id: app.id, name: app.name, description: app.description, icon: app.icon, bot: userOf(app.id) },
      user: db.accounts.get(integration.added_by)?.user ?? null,
      role_id: integration.role_id,
    });
  }
  return out;
});

route("DELETE", `/guilds/${ID}/integrations/${ID}`, ctx => {
  const [guildId = "", appId = ""] = ctx.params;
  requireGuildPerm(guildId, ctx.viewer.user.id, Perm.MANAGE_GUILD);
  if (!apps.applications.has(appId) || !db.guilds.get(guildId)?.members.has(appId)) fail(404, 10002, "Unknown Application");
  removeBotFromGuild(appId, guildId);
  return undefined;
});

// ---- commands ----

const CHAT_NAME = /^[-_\p{Ll}\p{Lo}\p{N}]{1,32}$/u;

function validateOption(option: ApplicationCommandOption, index: number): void {
  const field = (name: string) => `options.${index}.${name}`;
  if (typeof option.name !== "string" || !CHAT_NAME.test(option.name)) invalid(field("name"), "Must be 1-32 lowercase letters, numbers, '-' or '_'.");
  const description = (option.description ?? "").trim();
  if (description.length < 1 || description.length > 100) invalid(field("description"), "Must be between 1 and 100 in length.");
  const numeric = option.type === ApplicationCommandOptionType.Integer || option.type === ApplicationCommandOptionType.Number;
  if (!Object.values(ApplicationCommandOptionType).includes(option.type)) invalid(field("type"), "Unknown option type.");
  if (option.choices) {
    if (!(numeric || option.type === ApplicationCommandOptionType.String)) invalid(field("choices"), "Only string, integer and number options can have choices.");
    if (option.autocomplete) invalid(field("choices"), "Choices cannot be combined with autocomplete.");
    if (option.choices.length > 25) invalid(field("choices"), "Must be 25 or fewer in length.");
    for (const choice of option.choices) {
      const fits = option.type === ApplicationCommandOptionType.String ? typeof choice.value === "string" : typeof choice.value === "number" && (option.type !== ApplicationCommandOptionType.Integer || Number.isInteger(choice.value));
      if (!fits || !choice.name) invalid(field("choices"), "Choice values must match the option type.");
    }
  }
  if ((option.min_value !== undefined || option.max_value !== undefined) && !numeric) invalid(field("min_value"), "Only integer and number options have a range.");
  if (option.min_value !== undefined && option.max_value !== undefined && option.min_value > option.max_value) invalid(field("min_value"), "Must be at most max_value.");
}

function validateCommand(body: Record<string, unknown>, base?: ApplicationCommand): Omit<ApplicationCommand, "id" | "application_id" | "guild_id" | "version"> {
  const type = (body.type as ApplicationCommandType | undefined) ?? base?.type ?? ApplicationCommandType.ChatInput;
  if (base && type !== base.type) invalid("type", "The type of a command cannot change.");
  const name = (str(body.name) ?? base?.name ?? "").trim();
  const chat = type === ApplicationCommandType.ChatInput;
  if (chat ? !CHAT_NAME.test(name) : name.length < 1 || name.length > 32) invalid("name", chat ? "Must be 1-32 lowercase letters, numbers, '-' or '_'." : "Must be between 1 and 32 in length.");
  const description = (str(body.description) ?? base?.description ?? "").trim();
  if (chat && (description.length < 1 || description.length > 100)) invalid("description", "Must be between 1 and 100 in length.");
  if (!chat && description !== "") invalid("description", "User and message commands have no description.");
  const options = (Array.isArray(body.options) ? (body.options as ApplicationCommandOption[]) : (base?.options ?? [])).map(o => ({ ...o }));
  if (!chat && options.length > 0) invalid("options", "User and message commands have no options.");
  if (options.length > 25) invalid("options", "Must be 25 or fewer in length.");
  const names = new Set<string>();
  let optional = false;
  options.forEach((option, index) => {
    validateOption(option, index);
    if (names.has(option.name)) invalid(`options.${index}.name`, "Option names must be unique.");
    names.add(option.name);
    if (option.required && optional) invalid(`options.${index}.required`, "Required options must come before optional ones.");
    optional ||= !option.required;
  });
  let dmp = base?.default_member_permissions ?? null;
  if ("default_member_permissions" in body) {
    const raw = body.default_member_permissions;
    if (raw !== null && !(typeof raw === "string" && /^\d+$/.test(raw))) invalid("default_member_permissions", "Must be a decimal permission bitfield.");
    dmp = raw === null ? null : (parseBits(raw as string) & ALL_PERMISSIONS).toString();
  }
  const dm = typeof body.dm_permission === "boolean" ? body.dm_permission : (base?.dm_permission ?? true);
  return { type, name, description, ...(chat ? { options } : {}), default_member_permissions: dmp, dm_permission: dm };
}

function commandScope(ctx: Ctx, guild: boolean): { app: MockApp; guildId: string | null } {
  const app = apps.applications.get(ctx.params[0] ?? "");
  if (!app || (app.owner_id !== ctx.viewer.user.id && app.id !== ctx.viewer.user.id)) fail(404, 10002, "Unknown Application");
  const guildId = guild ? (ctx.params[1] ?? "") : null;
  if (guildId && !db.guilds.get(guildId)?.members.has(app.id)) fail(403, 50001, "Missing Access");
  return { app, guildId };
}

const scopeCommands = (appId: string, guildId: string | null) => [...apps.commands.values()].filter(c => c.application_id === appId && c.guild_id === guildId);

function upsert(appId: string, guildId: string | null, spec: ReturnType<typeof validateCommand>, existing?: ApplicationCommand): ApplicationCommand {
  const command: ApplicationCommand = { id: existing?.id ?? nextId(), application_id: appId, guild_id: guildId, version: nextId(), ...spec, dm_permission: guildId ? undefined : spec.dm_permission };
  if (guildId) delete command.dm_permission;
  apps.commands.set(command.id, command);
  return command;
}

function createCommand(ctx: Ctx, guild: boolean): ApplicationCommand {
  const { app, guildId } = commandScope(ctx, guild);
  const spec = validateCommand(ctx.body);
  const list = scopeCommands(app.id, guildId);
  const existing = list.find(c => c.type === spec.type && c.name === spec.name);
  const limit = spec.type === ApplicationCommandType.ChatInput ? 100 : 5;
  if (!existing && list.filter(c => c.type === spec.type).length >= limit) fail(400, 30032, "Maximum number of application commands reached");
  return upsert(app.id, guildId, spec, existing);
}

function overwriteCommands(ctx: Ctx, guild: boolean): ApplicationCommand[] {
  const { app, guildId } = commandScope(ctx, guild);
  const bodies = Array.isArray(ctx.body) ? (ctx.body as Record<string, unknown>[]) : [];
  const specs = bodies.map(body => validateCommand(body));
  const existing = scopeCommands(app.id, guildId);
  for (const command of existing) if (!specs.some(s => s.type === command.type && s.name === command.name)) apps.commands.delete(command.id);
  return specs.map(spec => upsert(app.id, guildId, spec, existing.find(c => c.type === spec.type && c.name === spec.name)));
}

function scopeCommand(ctx: Ctx, guild: boolean): ApplicationCommand {
  const { app, guildId } = commandScope(ctx, guild);
  const command = apps.commands.get(ctx.params[guild ? 2 : 1] ?? "");
  if (!command || command.application_id !== app.id || command.guild_id !== guildId) fail(404, 10063, "Unknown application command");
  return command;
}

for (const [prefix, guild] of [[`/applications/${ID}/commands`, false], [`/applications/${ID}/guilds/${ID}/commands`, true]] as const) {
  route("GET", prefix, ctx => {
    const { app, guildId } = commandScope(ctx, guild);
    return scopeCommands(app.id, guildId);
  });
  route("POST", prefix, ctx => createCommand(ctx, guild));
  route("PUT", prefix, ctx => overwriteCommands(ctx, guild));
  route("GET", `${prefix}/${ID}`, ctx => scopeCommand(ctx, guild));
  route("PATCH", `${prefix}/${ID}`, ctx => {
    const command = scopeCommand(ctx, guild);
    return upsert(command.application_id, command.guild_id, validateCommand(ctx.body, command), command);
  });
  route("DELETE", `${prefix}/${ID}`, ctx => {
    apps.commands.delete(scopeCommand(ctx, guild).id);
    return undefined;
  });
}

/** What the viewer may run in a channel (same rules as the server's `usable_commands`). */
export function usableCommands(channel: MockChannel, viewerId: string): { apps: MockApp[]; commands: ApplicationCommand[] } {
  if (channel.type === ChannelType.DM) {
    const found = [...apps.applications.values()].filter(a => channel.participant_ids?.includes(a.id) && a.id !== viewerId);
    const commands = [...apps.commands.values()].filter(c => found.some(a => a.id === c.application_id) && c.guild_id === null && c.dm_permission !== false);
    return { apps: found, commands };
  }
  const guildId = channel.guild_id;
  if (!guildId) return { apps: [], commands: [] };
  const bits = channelPermsOf(channel, viewerId);
  if (!hasBit(bits, Perm.USE_APPLICATION_COMMANDS)) return { apps: [], commands: [] };
  const guild = db.guilds.get(guildId);
  const found = [...apps.applications.values()].filter(a => guild?.members.has(a.id));
  const commands = [...apps.commands.values()]
    .filter(c => found.some(a => a.id === c.application_id) && (c.guild_id === null || c.guild_id === guildId))
    .filter(c => c.default_member_permissions === null || hasBit(bits, parseBits(c.default_member_permissions)))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { apps: found, commands };
}

route("GET", `/channels/${ID}/application-commands`, ({ viewer, params }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  const { apps: found, commands } = usableCommands(channel, viewer.user.id);
  const used = new Set(commands.map(c => c.application_id));
  return {
    applications: found.filter(a => used.has(a.id)).map(a => ({ id: a.id, name: a.name, icon: a.icon, bot_id: a.id })),
    application_commands: commands,
  };
});

// ---- interactions ----

function optionError(name: string, message: string): never {
  return invalid(`data.options.${name}`, message);
}

function idOf(value: unknown): string | null {
  return typeof value === "string" && /^\d+$/.test(value) ? value : typeof value === "number" ? String(value) : null;
}

/** Options checked against the command, like the server's `check_options`. */
export function checkOptions(definitions: ApplicationCommandOption[], given: InteractionDataOption[], autocomplete: boolean): void {
  const seen = new Set<string>();
  for (const option of given) {
    const definition = definitions.find(d => d.name === option.name);
    if (!definition) optionError(option.name, "Unknown option.");
    if (seen.has(option.name)) optionError(option.name, "Given more than once.");
    seen.add(option.name);
    if (definition.type !== option.type) optionError(option.name, "Wrong option type.");
    const focused = autocomplete && option.focused === true;
    const value = option.value;
    const inRange = (n: number) => focused || ((definition.min_value === undefined || n >= definition.min_value) && (definition.max_value === undefined || n <= definition.max_value));
    let fits: boolean;
    switch (definition.type) {
      case ApplicationCommandOptionType.String:
        fits = typeof value === "string" && (focused || (value.length >= (definition.min_length ?? 0) && value.length <= (definition.max_length ?? 6000)));
        break;
      case ApplicationCommandOptionType.Integer:
        fits = typeof value === "number" && Number.isInteger(value) && inRange(value);
        break;
      case ApplicationCommandOptionType.Number:
        fits = typeof value === "number" && Number.isFinite(value) && inRange(value);
        break;
      case ApplicationCommandOptionType.Boolean:
        fits = typeof value === "boolean";
        break;
      default:
        fits = idOf(value) !== null;
    }
    if (!fits) optionError(option.name, "Invalid value.");
    if (definition.choices && !focused && !definition.choices.some(c => c.value === value)) optionError(option.name, "Not one of the choices.");
  }
  if (!autocomplete) {
    const missing = definitions.find(d => d.required && !seen.has(d.name));
    if (missing) optionError(missing.name, "This option is required.");
  }
}

function resolve(channel: MockChannel, viewerId: string, options: InteractionDataOption[], command: ApplicationCommand, targetId: string | null): InteractionResolved {
  const resolved: InteractionResolved = {};
  const userIds = options.filter(o => o.type === ApplicationCommandOptionType.User).map(o => idOf(o.value) ?? "");
  if (command.type === ApplicationCommandType.User && targetId) userIds.push(targetId);
  if (userIds.length > 0) {
    resolved.users = {};
    for (const id of userIds) {
      const account = db.accounts.get(id);
      if (!account) invalid("data.options", "Unknown user.");
      resolved.users[id] = account.user;
      const member = channel.guild_id ? db.guilds.get(channel.guild_id)?.members.get(id) : undefined;
      if (member) (resolved.members ??= {})[id] = { nick: member.nick, roles: [...member.roles], joined_at: member.joined_at };
    }
  }
  for (const option of options.filter(o => o.type === ApplicationCommandOptionType.Channel)) {
    const target = db.channels.get(idOf(option.value) ?? "");
    if (!target || target.guild_id !== channel.guild_id) invalid("data.options", "Unknown channel.");
    (resolved.channels ??= {})[target.id] = { id: target.id, type: target.type, name: target.name, parent_id: target.parent_id };
  }
  for (const option of options.filter(o => o.type === ApplicationCommandOptionType.Role)) {
    const role = channel.guild_id ? db.guilds.get(channel.guild_id)?.guild.roles.find(r => r.id === idOf(option.value)) : undefined;
    if (!role) invalid("data.options", "Unknown role.");
    (resolved.roles ??= {})[role.id] = { ...role };
  }
  if (command.type === ApplicationCommandType.Message) {
    const message = sortedMessages(channel.id).find(m => m.id === targetId);
    if (!message) invalid("data.target_id", "Unknown message.");
    resolved.messages = { [message.id]: messageFor(message, viewerId) };
  }
  return resolved;
}

route("POST", "/interactions", ctx => {
  viewerIsBot(ctx);
  const body = ctx.body;
  const kind = body.type as InteractionType;
  if (kind === InteractionType.MessageComponent) return invokeComponent(ctx);
  if (kind !== InteractionType.ApplicationCommand && kind !== InteractionType.ApplicationCommandAutocomplete) invalid("type", "Must be 2, 3 or 4.");
  const autocomplete = kind === InteractionType.ApplicationCommandAutocomplete;
  const channel = requireChannel(str(body.channel_id) ?? "", ctx.viewer.user.id);
  const data = (body.data ?? {}) as { id?: string; type?: ApplicationCommandType; options?: InteractionDataOption[]; target_id?: string };
  const { commands } = usableCommands(channel, ctx.viewer.user.id);
  const command = commands.find(c => c.id === data.id && c.application_id === str(body.application_id));
  if (!command) {
    const exists = apps.commands.get(data.id ?? "");
    const botHere = !!channel.guild_id && !!db.guilds.get(channel.guild_id)?.members.has(str(body.application_id) ?? "");
    if (exists && botHere && (exists.guild_id === null || exists.guild_id === channel.guild_id)) fail(403, 50013, MISSING_PERMISSIONS);
    fail(404, 10063, "Unknown application command");
  }
  if (data.type !== command.type) invalid("data.type", "Does not match the command.");
  const options = data.options ?? [];
  checkOptions(command.options ?? [], options, autocomplete);
  if (autocomplete && options.filter(o => o.focused).length !== 1) invalid("data.options", "Exactly one option must be focused.");
  const targetId = command.type === ApplicationCommandType.ChatInput ? null : (data.target_id ?? invalid("data.target_id", "This field is required."));
  const resolved = resolve(channel, ctx.viewer.user.id, options, command, targetId);
  const interaction: MockInteraction = {
    id: nextId(),
    application_id: command.application_id,
    token: randomToken(),
    kind,
    user_id: ctx.viewer.user.id,
    channel_id: channel.id,
    command,
    target_id: targetId,
    nonce: str(body.nonce) ?? null,
    created: Date.now(),
    responded: false,
    original: null,
  };
  apps.interactions.set(interaction.id, interaction);
  const member = channel.guild_id ? membersOf(channel.guild_id).find(m => m.user.id === ctx.viewer.user.id) : undefined;
  const payload: Interaction = {
    id: interaction.id,
    application_id: command.application_id,
    type: kind,
    data: {
      id: command.id,
      name: command.name,
      type: command.type,
      ...(command.guild_id ? { guild_id: command.guild_id } : {}),
      ...(options.length ? { options } : {}),
      ...(Object.keys(resolved).length ? { resolved } : {}),
      ...(targetId ? { target_id: targetId } : {}),
    },
    guild_id: channel.guild_id,
    channel_id: channel.id,
    ...(member ? { member } : {}),
    user: ctx.viewer.user,
    token: interaction.token,
    app_permissions: channelPermsOf(channel, command.application_id).toString(),
    version: 1,
  };
  emit([command.application_id], "INTERACTION_CREATE", payload);
  const handler = botHandlers.get(command.application_id);
  if (handler) setTimeout(() => handler(payload), 150);
  if (!autocomplete) {
    setTimeout(() => {
      if (!interaction.responded) emit([interaction.user_id], "INTERACTION_FAILURE", { id: interaction.id, nonce: interaction.nonce, channel_id: channel.id, application_id: command.application_id });
    }, CALLBACK_WINDOW_MS);
  }
  return { id: interaction.id, nonce: interaction.nonce };
});

type Embed = Message["embeds"][number];

const webUrl = (url: unknown): string | undefined =>
  typeof url === "string" && url.length <= 2048 && /^https?:\/\//i.test(url.trim()) ? url : undefined;

/** Discord's limits for bot and webhook embeds: always rich, bounded text, only http(s) URLs. Returns the cleaned embed and its counted length. */
function cleanEmbed(raw: Embed, index: number): { embed: Embed; length: number } {
  const check = (text: unknown, max: number, name: string): number => {
    const length = typeof text === "string" ? [...text].length : 0;
    if (length > max) invalid(`embeds.${index}.${name}`, `Must be ${max} or fewer in length.`);
    return length;
  };
  let length = check(raw.title, 256, "title") + check(raw.description, 4096, "description");
  const embed: Embed = { ...raw, type: "rich" };
  if (raw.footer) {
    length += check(raw.footer.text, 2048, "footer.text");
    embed.footer = { text: raw.footer.text, ...(webUrl(raw.footer.icon_url) ? { icon_url: raw.footer.icon_url } : {}) };
  }
  if (raw.author) {
    length += check(raw.author.name, 256, "author.name");
    embed.author = { name: raw.author.name, ...(webUrl(raw.author.url) ? { url: raw.author.url } : {}), ...(webUrl(raw.author.icon_url) ? { icon_url: raw.author.icon_url } : {}) };
  }
  if (raw.fields) {
    if (raw.fields.length > 25) invalid(`embeds.${index}.fields`, "Must be 25 or fewer in length.");
    raw.fields.forEach((field, n) => {
      length += check(field.name, 256, `fields.${n}.name`) + check(field.value, 1024, `fields.${n}.value`);
    });
  }
  if (!webUrl(raw.url)) delete embed.url;
  for (const key of ["image", "thumbnail", "video"] as const) if (raw[key] && !webUrl(raw[key]?.url)) delete embed[key];
  return { embed, length };
}

function validateBody(content: unknown, embeds: unknown, allowEmpty: boolean): { content: string; embeds: Message["embeds"] } {
  const text = (typeof content === "string" ? content : "").trim();
  if (text.length > 2000) invalid("content", "Must be 2000 or fewer in length.");
  const raw = Array.isArray(embeds) ? (embeds as Message["embeds"]) : [];
  if (raw.length > 10) invalid("embeds", "Must be 10 or fewer in length.");
  const cleaned = raw.map(cleanEmbed);
  if (cleaned.reduce((sum, item) => sum + item.length, 0) > 6000) invalid("embeds", "Embeds must be 6000 or fewer characters in total.");
  const list = cleaned.map(item => item.embed);
  if (!text && list.length === 0 && !allowEmpty) fail(400, 50006, "Cannot send an empty message");
  return { content: text, embeds: list };
}

/** Posts a message of the interaction's bot: in the channel, or only for the invoking user when ephemeral. */
function postMessage(interaction: MockInteraction, data: Record<string, unknown>, original: boolean, loading: boolean): Message {
  const channel = db.channels.get(interaction.channel_id);
  if (!channel) fail(404, 10003, "Unknown Channel");
  const components = cleanComponents(data.components);
  const { content, embeds } = validateBody(data.content, data.embeds, loading || components.length > 0);
  const ephemeral = ((Number(data.flags) || 0) & MessageFlags.Ephemeral) !== 0;
  const flags = (ephemeral ? MessageFlags.Ephemeral : 0) | (loading ? MessageFlags.Loading : 0);
  const command = original ? interaction.command : null;
  const type = !command ? MessageType.Default : command.type === ApplicationCommandType.ChatInput ? MessageType.ChatInputCommand : MessageType.ContextMenuCommand;
  const metadata: MessageInteractionMetadata | undefined = command
    ? {
        id: interaction.id,
        type: InteractionType.ApplicationCommand,
        user: userOf(interaction.user_id),
        name: command.name,
        command_type: command.type,
        ...(command.type === ApplicationCommandType.User && interaction.target_id ? { target_user: userOf(interaction.target_id) } : {}),
        ...(command.type === ApplicationCommandType.Message && interaction.target_id ? { target_message_id: interaction.target_id } : {}),
      }
    : undefined;
  if (ephemeral) {
    const message: Message = {
      id: nextId(),
      channel_id: channel.id,
      guild_id: channel.guild_id,
      author: userOf(interaction.application_id),
      content,
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      type,
      mentions: [],
      mention_roles: [],
      mention_everyone: false,
      attachments: [],
      embeds,
      components,
      reactions: [],
      pinned: false,
      tts: false,
      message_reference: null,
      referenced_message: null,
      nonce: null,
      flags,
      webhook_id: interaction.application_id,
      application_id: interaction.application_id,
      ...(metadata ? { interaction_metadata: metadata } : {}),
    };
    apps.ephemerals.set(message.id, { message, recipient: interaction.user_id });
    emit([interaction.user_id], "MESSAGE_CREATE", message);
    return message;
  }
  const stored = addMessage({ channel, author_id: interaction.application_id, content, type, flags, allowEveryone: false, extra: { webhook_id: interaction.application_id, application_id: interaction.application_id, interaction_metadata: metadata, embeds, components } });
  return messageFor(stored, interaction.user_id);
}

route("POST", `/interactions/${ID}/([^/]+)/callback`, ({ params, body }) => {
  const interaction = apps.interactions.get(params[0] ?? "");
  if (!interaction || interaction.token !== params[1]) fail(404, 10062, "Unknown interaction");
  const kind = body.type as InteractionCallbackType;
  const autocomplete = interaction.kind === InteractionType.ApplicationCommandAutocomplete;
  if ((kind === InteractionCallbackType.ApplicationCommandAutocompleteResult) !== autocomplete) invalid("type", "This response type does not fit the interaction.");
  const data = (body.data ?? {}) as Record<string, unknown>;
  const click = interaction.kind === InteractionType.MessageComponent;
  if ((kind === InteractionCallbackType.DeferredUpdateMessage || kind === InteractionCallbackType.UpdateMessage) && !click) invalid("type", "This response type does not fit the interaction.");
  if (interaction.responded) fail(400, 40060, "Interaction has already been acknowledged");
  if (Date.now() - interaction.created > CALLBACK_WINDOW_MS) fail(404, 10062, "Unknown interaction");
  if (kind === InteractionCallbackType.ApplicationCommandAutocompleteResult) {
    const choices = (Array.isArray(data.choices) ? data.choices : []) as ApplicationCommandOptionChoice[];
    if (choices.length > 25) invalid("data.choices", "Must be 25 or fewer in length.");
    interaction.responded = true;
    emit([interaction.user_id], "APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE", { id: interaction.id, nonce: interaction.nonce, choices });
    return undefined;
  }
  if (kind === InteractionCallbackType.DeferredUpdateMessage || kind === InteractionCallbackType.UpdateMessage) {
    const clicked = clickedMessage(interaction);
    if (kind === InteractionCallbackType.UpdateMessage) applyEdit(clicked, data);
    interaction.responded = true;
    interaction.original = { id: clicked.stored?.id ?? clicked.ephemeral!.message.id, ephemeral: !!clicked.ephemeral };
    announceClick(interaction);
    return undefined;
  }
  if (kind !== InteractionCallbackType.ChannelMessageWithSource && kind !== InteractionCallbackType.DeferredChannelMessageWithSource) invalid("type", "Unknown response type.");
  const loading = kind === InteractionCallbackType.DeferredChannelMessageWithSource;
  const components = cleanComponents(data.components);
  validateBody(data.content, data.embeds, loading || components.length > 0);
  interaction.responded = true;
  const message = postMessage(interaction, loading ? { flags: data.flags } : data, !click, loading);
  interaction.original = { id: message.id, ephemeral: ((message.flags ?? 0) & MessageFlags.Ephemeral) !== 0 };
  announceClick(interaction);
  return undefined;
});

/** The user's sessions learn that a component click was answered (type 6 shows no message, so nothing else would tell them). */
function announceClick(interaction: MockInteraction): void {
  if (interaction.kind !== InteractionType.MessageComponent) return;
  emit([interaction.user_id], "INTERACTION_SUCCESS", { id: interaction.id, nonce: interaction.nonce, channel_id: interaction.channel_id, application_id: interaction.application_id });
}

/** The message a click sits on (stored, or an ephemeral of the clicker). */
function clickedMessage(interaction: MockInteraction): { stored?: MockMessage; ephemeral?: { message: Message; recipient: string } } {
  const id = interaction.message_id ?? "";
  const ephemeral = apps.ephemerals.get(id);
  if (ephemeral) return { ephemeral };
  const stored = sortedMessages(interaction.channel_id).find(m => m.id === id);
  if (!stored) fail(404, 10008, "Unknown Message");
  return { stored };
}

// ---- message components ----

type ComponentEmoji = NonNullable<MessageComponent["emoji"]>;

/** Validates what an application sent as `components` like the server's `validate_components` and returns it rebuilt from known fields. */
function cleanComponents(raw: unknown): MessageComponent[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) invalid("components", "Must be a list.");
  if (raw.length > 5) invalid("components", "Must be 5 or fewer in length.");
  const ids = new Set<string>();
  const text = (value: unknown, path: string, max: number, min = 0): string => {
    const length = typeof value === "string" ? [...value].length : 0;
    if (typeof value !== "string" || length > max || length < min) invalid(path, min ? `Must be between ${min} and ${max} in length.` : `Must be ${max} or fewer in length.`);
    return value;
  };
  const emojiOf = (value: unknown, path: string): ComponentEmoji | undefined => {
    if (value === undefined || value === null) return undefined;
    const e = value as ComponentEmoji;
    if (typeof value !== "object" || (e.id === undefined && !e.name) || (e.id !== undefined && !/^\d+$/.test(String(e.id))) || (e.name !== undefined && [...String(e.name)].length > 32)) invalid(path, "Invalid emoji.");
    return { ...(e.id !== undefined ? { id: e.id } : {}), ...(e.name !== undefined ? { name: e.name } : {}), ...(e.animated ? { animated: true } : {}) };
  };
  const customId = (value: unknown, path: string): string => {
    const id = text(value, path, 100, 1);
    if (ids.has(id)) invalid(path, "Component custom ids must be unique.");
    ids.add(id);
    return id;
  };
  return raw.map((row: MessageComponent, r) => {
    const at = `components.${r}`;
    if (row?.type !== ComponentType.ActionRow) invalid(`${at}.type`, "Must be 1 (action row).");
    const children = row.components ?? [];
    if (children.length < 1 || children.length > 5) invalid(`${at}.components`, "Must be between 1 and 5 in length.");
    const cleaned = children.map((child, n): MessageComponent => {
      const path = `${at}.components.${n}`;
      if (child.type === ComponentType.StringSelect) {
        if (children.length > 1) invalid(path, "A select menu takes a whole row.");
        const options = child.options ?? [];
        if (options.length < 1 || options.length > 25) invalid(`${path}.options`, "Must be between 1 and 25 in length.");
        const values = new Set<string>();
        return {
          type: ComponentType.StringSelect,
          custom_id: customId(child.custom_id, `${path}.custom_id`),
          options: options.map((o, i) => {
            const value = text(o.value, `${path}.options.${i}.value`, 100, 1);
            if (values.has(value)) invalid(`${path}.options.${i}.value`, "Option values must be unique.");
            values.add(value);
            const emoji = emojiOf(o.emoji, `${path}.options.${i}.emoji`);
            return {
              label: text(o.label, `${path}.options.${i}.label`, 100, 1),
              value,
              ...(o.description ? { description: text(o.description, `${path}.options.${i}.description`, 100) } : {}),
              ...(emoji ? { emoji } : {}),
              ...(o.default ? { default: true } : {}),
            };
          }),
          ...(child.placeholder ? { placeholder: text(child.placeholder, `${path}.placeholder`, 150) } : {}),
          min_values: 1,
          max_values: 1,
          ...(child.disabled ? { disabled: true } : {}),
        };
      }
      if (child.type !== ComponentType.Button) invalid(`${path}.type`, "Must be 2 (button) or 3 (select menu).");
      if (!child.style || child.style < 1 || child.style > 5) invalid(`${path}.style`, "Must be between 1 and 5.");
      const emoji = emojiOf(child.emoji, `${path}.emoji`);
      const label = child.label === undefined ? undefined : text(child.label, `${path}.label`, 80);
      if (!label && !emoji) invalid(`${path}.label`, "A button needs a label or an emoji.");
      const button: MessageComponent = { type: ComponentType.Button, style: child.style, ...(label ? { label } : {}), ...(emoji ? { emoji } : {}), ...(child.disabled ? { disabled: true } : {}) };
      if (child.style === ButtonStyle.Link) {
        if (child.custom_id !== undefined) invalid(`${path}.custom_id`, "A link button has no custom id.");
        let url: URL | null = null;
        try {
          url = new URL(String(child.url ?? "").trim());
        } catch {
          url = null;
        }
        if (!url || url.protocol !== "https:" || !url.hostname) invalid(`${path}.url`, "Must be an https URL.");
        return { ...button, url: url.href };
      }
      if (child.url !== undefined) invalid(`${path}.url`, "Only a link button has a url.");
      return { ...button, custom_id: customId(child.custom_id, `${path}.custom_id`) };
    });
    return { type: ComponentType.ActionRow, components: cleaned };
  });
}

/** POST /interactions with type 3: a click on a button or select of an application message. */
function invokeComponent(ctx: Ctx): { id: string; nonce: string | null } {
  const { body, viewer } = ctx;
  const channel = requireChannel(str(body.channel_id) ?? "", viewer.user.id);
  const applicationId = str(body.application_id) ?? "";
  const messageId = str(body.message_id) ?? invalid("message_id", "This field is required.");
  const data = (body.data ?? {}) as { custom_id?: unknown; component_type?: unknown; values?: unknown };
  const ephemeral = apps.ephemerals.get(messageId);
  const stored = ephemeral ? undefined : sortedMessages(channel.id).find(m => m.id === messageId);
  const message = ephemeral ? (ephemeral.recipient === viewer.user.id && ephemeral.message.channel_id === channel.id ? ephemeral.message : undefined) : stored ? messageFor(stored, viewer.user.id) : undefined;
  if (!message || message.application_id !== applicationId) fail(404, 10008, "Unknown Message");
  if (!usableCommands(channel, viewer.user.id).apps.some(a => a.id === applicationId)) fail(channel.guild_id ? 403 : 404, channel.guild_id ? 50013 : 10002, channel.guild_id ? MISSING_PERMISSIONS : "Unknown Application");
  const component = (message.components ?? []).flatMap(row => row.components ?? []).find(c => c.custom_id === data.custom_id);
  if (!component || component.type !== data.component_type) invalid("data.custom_id", "Unknown component.");
  if (component.disabled) invalid("data.custom_id", "This component is disabled.");
  const values = data.values;
  if (component.type === ComponentType.StringSelect) {
    if (!Array.isArray(values) || values.length !== 1 || !component.options?.some(o => o.value === values[0])) invalid("data.values", "Choose exactly one of the options.");
  } else if (values !== undefined) invalid("data.values", "A button takes no values.");
  const interaction: MockInteraction = {
    id: nextId(),
    application_id: applicationId,
    token: randomToken(),
    kind: InteractionType.MessageComponent,
    user_id: viewer.user.id,
    channel_id: channel.id,
    command: null,
    message_id: message.id,
    target_id: null,
    nonce: str(body.nonce) ?? null,
    created: Date.now(),
    responded: false,
    original: null,
  };
  apps.interactions.set(interaction.id, interaction);
  const member = channel.guild_id ? membersOf(channel.guild_id).find(m => m.user.id === viewer.user.id) : undefined;
  const payload: Interaction = {
    id: interaction.id,
    application_id: applicationId,
    type: InteractionType.MessageComponent,
    data: { custom_id: component.custom_id, component_type: component.type, ...(values ? { values: values as string[] } : {}) },
    guild_id: channel.guild_id,
    channel_id: channel.id,
    ...(member ? { member } : {}),
    user: viewer.user,
    token: interaction.token,
    app_permissions: channelPermsOf(channel, applicationId).toString(),
    version: 1,
    message,
  };
  emit([applicationId], "INTERACTION_CREATE", payload);
  const handler = botHandlers.get(applicationId);
  if (handler) setTimeout(() => handler(payload), 150);
  setTimeout(() => {
    if (!interaction.responded) emit([interaction.user_id], "INTERACTION_FAILURE", { id: interaction.id, nonce: interaction.nonce, channel_id: channel.id, application_id: applicationId });
  }, CALLBACK_WINDOW_MS);
  return { id: interaction.id, nonce: interaction.nonce };
}

// ---- ephemeral messages (hooks used by the message routes) ----

/** The viewer's ephemeral messages in a channel, merged into a page of history (newest first). */
export function mergeEphemerals(channelId: string, viewerId: string, page: Message[], limit: number, full: boolean): Message[] {
  const oldest = page.at(-1)?.id;
  const mine = [...apps.ephemerals.values()]
    .filter(e => e.recipient === viewerId && e.message.channel_id === channelId && (!full || !oldest || compareIds(e.message.id, oldest) >= 0))
    .map(e => e.message);
  if (mine.length === 0) return page;
  return [...page, ...mine].sort((a, b) => compareIds(b.id, a.id)).slice(0, limit);
}

/** DELETE of an ephemeral message by its recipient; false when `messageId` is not one of theirs. */
export function dismissEphemeral(channelId: string, messageId: string, viewerId: string): boolean {
  const entry = apps.ephemerals.get(messageId);
  if (!entry || entry.recipient !== viewerId || entry.message.channel_id !== channelId) return false;
  apps.ephemerals.delete(messageId);
  emit([viewerId], "MESSAGE_DELETE", { id: messageId, channel_id: channelId, guild_id: entry.message.guild_id });
  return true;
}

// ---- webhooks ----

function webhookFor(hook: MockWebhook, secrets: boolean): Webhook {
  return {
    id: hook.id,
    type: WebhookType.Incoming,
    guild_id: hook.guild_id,
    channel_id: hook.channel_id,
    name: hook.name,
    avatar: hook.avatar,
    application_id: null,
    ...(secrets ? { user: userOf(hook.creator_id), token: hook.token, url: `${typeof window === "undefined" ? "http://mock.local" : window.location.origin}/api/v1/webhooks/${hook.id}/${hook.token}` } : {}),
  };
}

function webhookName(raw: unknown, field = "name"): string {
  const name = (typeof raw === "string" ? raw : "").trim();
  if (name.length < 1 || name.length > 80) invalid(field, "Must be between 1 and 80 in length.");
  if (/clyde|discord/i.test(name)) invalid(field, 'Username cannot contain "clyde" or "discord".');
  return name;
}

function announceWebhooks(channel: MockChannel): void {
  if (!channel.guild_id) return;
  const managers = channelAudience(channel).filter(id => hasBit(channelPermsOf(channel, id), Perm.MANAGE_WEBHOOKS));
  emit(managers, "WEBHOOKS_UPDATE", { guild_id: channel.guild_id, channel_id: channel.id });
}

function manageableChannel(channelId: string, viewerId: string): MockChannel {
  const channel = requireChannel(channelId, viewerId);
  if (!hasBit(channelPermsOf(channel, viewerId), Perm.MANAGE_WEBHOOKS)) fail(403, 50013, MISSING_PERMISSIONS);
  return channel;
}

route("POST", `/channels/${ID}/webhooks`, ({ viewer, params, body }) => {
  const channel = manageableChannel(params[0] ?? "", viewer.user.id);
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) fail(400, 50024, "Cannot execute action on this channel type");
  const name = webhookName(body.name);
  if ([...apps.webhooks.values()].filter(w => w.channel_id === channel.id).length >= 15) fail(400, 30007, "Maximum number of webhooks reached (15)");
  const pending = body.avatar_attachment_id ? db.pending.get(String(body.avatar_attachment_id)) : undefined;
  const hook: MockWebhook = { id: nextId(), guild_id: channel.guild_id ?? "", channel_id: channel.id, name, avatar: pending?.attachment.url ?? null, token: randomToken(34), creator_id: viewer.user.id };
  const account = createAccount({ id: hook.id, username: `webhook-${hook.id}`, global_name: name, password: randomToken() });
  account.user.bot = true;
  apps.webhooks.set(hook.id, hook);
  announceWebhooks(channel);
  return webhookFor(hook, true);
});

route("GET", `/channels/${ID}/webhooks`, ({ viewer, params }) => {
  const channel = manageableChannel(params[0] ?? "", viewer.user.id);
  return [...apps.webhooks.values()].filter(w => w.channel_id === channel.id).map(w => webhookFor(w, true));
});

route("GET", `/guilds/${ID}/webhooks`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  const managed = [...db.channels.values()].filter(c => c.guild_id === guildId && hasBit(channelPermsOf(c, viewer.user.id), Perm.MANAGE_WEBHOOKS)).map(c => c.id);
  if (managed.length === 0) fail(403, 50013, MISSING_PERMISSIONS);
  return [...apps.webhooks.values()].filter(w => managed.includes(w.channel_id)).map(w => webhookFor(w, true));
});

function managedWebhook(id: string, viewerId: string): { hook: MockWebhook; channel: MockChannel } {
  const hook = apps.webhooks.get(id);
  if (!hook) fail(404, 10015, "Unknown Webhook");
  return { hook, channel: manageableChannel(hook.channel_id, viewerId) };
}

route("GET", `/webhooks/${ID}`, ({ viewer, params }) => webhookFor(managedWebhook(params[0] ?? "", viewer.user.id).hook, true));

route("PATCH", `/webhooks/${ID}`, ({ viewer, params, body }) => {
  const { hook, channel } = managedWebhook(params[0] ?? "", viewer.user.id);
  if ("name" in body) hook.name = webhookName(body.name);
  if ("avatar_attachment_id" in body) hook.avatar = body.avatar_attachment_id ? (db.pending.get(String(body.avatar_attachment_id))?.attachment.url ?? hook.avatar) : null;
  const target = str(body.channel_id);
  if (target && target !== hook.channel_id) {
    const next = manageableChannel(target, viewer.user.id);
    if (next.guild_id !== channel.guild_id) invalid("channel_id", "Must be a channel of the same server.");
    if (next.type !== ChannelType.GuildText && next.type !== ChannelType.GuildAnnouncement) fail(400, 50024, "Cannot execute action on this channel type");
    if ([...apps.webhooks.values()].filter(w => w.channel_id === next.id).length >= 15) fail(400, 30007, "Maximum number of webhooks reached (15)");
    hook.channel_id = next.id;
    announceWebhooks(next);
  }
  announceWebhooks(channel);
  return webhookFor(hook, true);
});

route("DELETE", `/webhooks/${ID}`, ({ viewer, params }) => {
  const { hook, channel } = managedWebhook(params[0] ?? "", viewer.user.id);
  apps.webhooks.delete(hook.id);
  announceWebhooks(channel);
  return undefined;
});

/** Webhook execute (also callable from Playwright through `__vokkoMock.executeWebhook`). */
export function executeWebhook(hook: MockWebhook, body: Record<string, unknown>): Message {
  const channel = db.channels.get(hook.channel_id);
  if (!channel) fail(404, 10015, "Unknown Webhook");
  const { content, embeds } = validateBody(body.content, body.embeds, false);
  const name = body.username !== undefined ? webhookName(body.username, "username") : hook.name;
  const avatar = typeof body.avatar_url === "string" ? body.avatar_url : hook.avatar;
  if (avatar && !/^https?:\/\//.test(avatar) && avatar !== hook.avatar) invalid("avatar_url", "Must be an http or https URL of at most 2048 characters.");
  const stored = addMessage({ channel, author_id: hook.id, content, allowEveryone: false, extra: { webhook_id: hook.id, author_name: name, author_avatar: avatar, embeds } });
  return messageFor(stored, hook.creator_id);
}

type Target = { kind: "webhook"; hook: MockWebhook } | { kind: "interaction"; interaction: MockInteraction };

function target(id: string, token: string): Target {
  const hook = apps.webhooks.get(id);
  if (hook) {
    if (hook.token !== token) fail(401, 50027, "Invalid Webhook Token");
    return { kind: "webhook", hook };
  }
  const interaction = [...apps.interactions.values()].find(i => i.application_id === id && i.token === token);
  if (!interaction) fail(404, 10015, "Unknown Webhook");
  if (Date.now() - interaction.created > TOKEN_LIFETIME_MS) fail(404, 10062, "Unknown interaction");
  return { kind: "interaction", interaction };
}

route("GET", `/webhooks/${ID}/([^/]+)`, ({ params }) => {
  const found = target(params[0] ?? "", params[1] ?? "");
  if (found.kind !== "webhook") fail(404, 10015, "Unknown Webhook");
  return webhookFor(found.hook, false);
});

route("POST", `/webhooks/${ID}/([^/]+)`, ({ params, query, body }) => {
  const found = target(params[0] ?? "", params[1] ?? "");
  if (found.kind === "interaction") {
    if (!found.interaction.responded || !found.interaction.original) fail(404, 10062, "Unknown interaction");
    return postMessage(found.interaction, body, false, false);
  }
  const message = executeWebhook(found.hook, body);
  return query.get("wait") === "true" ? message : undefined;
});

// token edit: name and clearing the avatar only (an upload needs a user); moving needs the authenticated route
route("PATCH", `/webhooks/${ID}/([^/]+)`, ({ params, body }) => {
  const found = target(params[0] ?? "", params[1] ?? "");
  if (found.kind !== "webhook") fail(404, 10015, "Unknown Webhook");
  if ("channel_id" in body) invalid("channel_id", "Cannot be changed with a webhook token.");
  if ("avatar_attachment_id" in body && body.avatar_attachment_id !== null) invalid("avatar_attachment_id", "Only null (remove the avatar) works with a webhook token.");
  const { hook } = found;
  if ("name" in body) hook.name = webhookName(body.name);
  if ("avatar_attachment_id" in body) hook.avatar = null;
  const channel = db.channels.get(hook.channel_id);
  if (channel) announceWebhooks(channel);
  return webhookFor(hook, false);
});

route("DELETE", `/webhooks/${ID}/([^/]+)`, ({ params }) => {
  const found = target(params[0] ?? "", params[1] ?? "");
  if (found.kind !== "webhook") fail(404, 10015, "Unknown Webhook");
  apps.webhooks.delete(found.hook.id);
  const channel = db.channels.get(found.hook.channel_id);
  if (channel) announceWebhooks(channel);
  return undefined;
});

/** The message a `/messages/{mid}` URL names: (stored message | ephemeral entry). */
function targetMessage(found: Target, mid: string): { stored?: MockMessage; ephemeral?: { message: Message; recipient: string } } {
  if (found.kind === "webhook") {
    const stored = sortedMessages(found.hook.channel_id).find(m => m.id === mid && m.webhook_id === found.hook.id);
    if (!stored) fail(404, 10008, "Unknown Message");
    return { stored };
  }
  const interaction = found.interaction;
  const id = mid === "@original" ? interaction.original?.id : mid;
  if (!id) fail(404, 10008, "Unknown Message");
  const ephemeral = apps.ephemerals.get(id);
  if (ephemeral && ephemeral.recipient === interaction.user_id && ephemeral.message.application_id === interaction.application_id) return { ephemeral };
  const stored = sortedMessages(interaction.channel_id).find(m => m.id === id && m.application_id === interaction.application_id);
  if (!stored) fail(404, 10008, "Unknown Message");
  return { stored };
}

route("GET", `/webhooks/${ID}/([^/]+)/messages/([^/]+)`, ({ params }) => {
  const found = target(params[0] ?? "", params[1] ?? "");
  const { stored, ephemeral } = targetMessage(found, params[2] ?? "");
  return ephemeral ? ephemeral.message : messageFor(stored!, stored!.author_id);
});

route("PATCH", `/webhooks/${ID}/([^/]+)/messages/([^/]+)`, ({ params, body }) => {
  const found = target(params[0] ?? "", params[1] ?? "");
  return applyEdit(targetMessage(found, params[2] ?? ""), body);
});

/** Edits a message of an application (content, embeds, components; what is left out stays) and announces the change. */
function applyEdit({ stored, ephemeral }: { stored?: MockMessage; ephemeral?: { message: Message; recipient: string } }, body: Record<string, unknown>): Message {
  const components = body.components === undefined ? undefined : cleanComponents(body.components);
  if (ephemeral) {
    const message = ephemeral.message;
    const wasLoading = ((message.flags ?? 0) & MessageFlags.Loading) !== 0;
    const next = validateBody(body.content ?? message.content, body.embeds ?? message.embeds, false);
    message.content = next.content;
    message.embeds = next.embeds;
    if (components) message.components = components;
    message.flags = (message.flags ?? 0) & ~MessageFlags.Loading;
    if (!wasLoading) message.edited_timestamp = new Date().toISOString();
    emit([ephemeral.recipient], "MESSAGE_UPDATE", { ...message });
    return message;
  }
  const message = stored!;
  const wasLoading = ((message.flags ?? 0) & MessageFlags.Loading) !== 0;
  const next = validateBody(body.content ?? message.content, body.embeds ?? message.embeds ?? [], (components ?? message.components ?? []).length > 0);
  message.content = next.content;
  message.embeds = next.embeds;
  if (components) message.components = components;
  message.flags = (message.flags ?? 0) & ~MessageFlags.Loading;
  if (!message.flags) delete message.flags;
  if (!wasLoading) message.edited_timestamp = new Date().toISOString();
  const channel = db.channels.get(message.channel_id);
  if (channel) for (const id of channelAudience(channel)) emit([id], "MESSAGE_UPDATE", messageFor(message, id));
  return messageFor(message, message.author_id);
}

route("DELETE", `/webhooks/${ID}/([^/]+)/messages/([^/]+)`, ({ params }) => {
  const found = target(params[0] ?? "", params[1] ?? "");
  const { stored, ephemeral } = targetMessage(found, params[2] ?? "");
  if (ephemeral) {
    dismissEphemeral(ephemeral.message.channel_id, ephemeral.message.id, ephemeral.recipient);
    return undefined;
  }
  const channel = db.channels.get(stored!.channel_id);
  const list = sortedMessages(stored!.channel_id);
  list.splice(list.indexOf(stored!), 1);
  if (channel) {
    channel.last_message_id = list.at(-1)?.id ?? null;
    emit(channelAudience(channel), "MESSAGE_DELETE", { id: stored!.id, channel_id: channel.id, guild_id: channel.guild_id });
  }
  return undefined;
});

// ---- the seeded echo bot ----

/** Answers like `examples/echo-bot`: /echo (ephemeral), /roll (public, deferred first), /pick (autocomplete), Wave at, Quote. */
export function echoBotHandler(interaction: Interaction): void {
  const record = apps.interactions.get(interaction.id);
  if (!record) return;
  const option = (name: string) => interaction.data.options?.find(o => o.name === name)?.value;
  const reply = (type: InteractionCallbackType, data: Record<string, unknown>) => handleRouteInternal("POST", `/interactions/${interaction.id}/${interaction.token}/callback`, { type, data });
  if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
    const typed = String(option("fruit") ?? "").toLowerCase();
    const fruits = ["apple", "banana", "cherry", "grape", "lemon", "mango", "orange", "peach", "pear", "plum"];
    reply(InteractionCallbackType.ApplicationCommandAutocompleteResult, { choices: fruits.filter(f => f.includes(typed)).slice(0, 25).map(f => ({ name: f, value: f })) });
    return;
  }
  if (interaction.type === InteractionType.MessageComponent) {
    const values = interaction.data.values;
    switch (interaction.data.custom_id) {
      case "confirm":
        reply(InteractionCallbackType.UpdateMessage, { content: "Confirmed. Nothing was deleted.", components: [] });
        return;
      case "cancel":
        reply(InteractionCallbackType.UpdateMessage, { content: "Cancelled.", components: [] });
        return;
      case "later":
        reply(InteractionCallbackType.DeferredUpdateMessage, {});
        return;
      case "flavor":
        reply(InteractionCallbackType.ChannelMessageWithSource, { content: `You picked ${values?.[0] ?? "nothing"}.`, flags: MessageFlags.Ephemeral });
        return;
    }
    return;
  }
  switch (interaction.data.name) {
    case "echo":
      reply(InteractionCallbackType.ChannelMessageWithSource, { content: String(option("text") ?? ""), flags: MessageFlags.Ephemeral });
      return;
    case "roll": {
      const sides = Number(option("sides") ?? 6);
      reply(InteractionCallbackType.DeferredChannelMessageWithSource, {});
      setTimeout(() => {
        handleRouteInternal("PATCH", `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, { content: `🎲 You rolled **${1 + Math.floor(Math.random() * sides)}** (d${sides})` });
      }, 600);
      return;
    }
    case "confirm":
      reply(InteractionCallbackType.ChannelMessageWithSource, {
        content: "Delete everything?",
        components: [
          {
            type: ComponentType.ActionRow,
            components: [
              { type: ComponentType.Button, style: ButtonStyle.Success, label: "Confirm", custom_id: "confirm" },
              { type: ComponentType.Button, style: ButtonStyle.Danger, label: "Cancel", custom_id: "cancel" },
              { type: ComponentType.Button, style: ButtonStyle.Secondary, label: "Ask later", custom_id: "later" },
              { type: ComponentType.Button, style: ButtonStyle.Link, label: "Docs", url: "https://example.com/docs" },
            ],
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.StringSelect,
                custom_id: "flavor",
                placeholder: "Pick a flavor",
                options: [
                  { label: "Vanilla", value: "vanilla", description: "The classic" },
                  { label: "Chocolate", value: "chocolate" },
                  { label: "Mint", value: "mint", emoji: { name: "🌿" } },
                ],
              },
            ],
          },
        ],
      });
      return;
    case "pick":
      reply(InteractionCallbackType.ChannelMessageWithSource, { content: `You picked ${String(option("fruit") ?? "nothing")}.` });
      return;
    case "Wave at": {
      const target = interaction.data.resolved?.users?.[interaction.data.target_id ?? ""];
      reply(InteractionCallbackType.ChannelMessageWithSource, { content: `👋 <@${interaction.user.id}> waves at <@${target?.id ?? ""}>!` });
      return;
    }
    case "Quote": {
      const quoted = interaction.data.resolved?.messages?.[interaction.data.target_id ?? ""];
      reply(InteractionCallbackType.ChannelMessageWithSource, { content: `> ${(quoted?.content ?? "").split("\n").join("\n> ")}\n— ${quoted?.author.global_name ?? quoted?.author.username ?? "someone"}` });
      return;
    }
  }
}

/** Calls a mock route as nobody in particular (token routes need no viewer). Set by index.ts to avoid an import cycle. */
let handleRouteInternal: (method: string, path: string, body: unknown) => unknown = () => undefined;
export function setInternalRouter(fn: typeof handleRouteInternal): void {
  handleRouteInternal = fn;
}

export const ECHO_COMMANDS: Record<string, unknown>[] = [
  { name: "echo", description: "Repeat text back (only you see it)", options: [{ type: ApplicationCommandOptionType.String, name: "text", description: "What to say", required: true, max_length: 2000 }] },
  { name: "roll", description: "Roll a die", options: [{ type: ApplicationCommandOptionType.Integer, name: "sides", description: "Number of sides", min_value: 2, max_value: 100 }] },
  {
    name: "pick",
    description: "Pick a fruit",
    options: [
      { type: ApplicationCommandOptionType.String, name: "fruit", description: "Start typing a fruit", required: true, autocomplete: true },
      { type: ApplicationCommandOptionType.String, name: "size", description: "How big", choices: [{ name: "Small", value: "s" }, { name: "Large", value: "l" }] },
    ],
  },
  { name: "confirm", description: "Ask before doing something (buttons and a select)" },
  { name: "Wave at", type: ApplicationCommandType.User },
  { name: "Quote", type: ApplicationCommandType.Message },
];

/** Seed: the Echo application owned by `ownerId` with its commands and handler (not in any server: see `installEchoBot`). */
export function seedEchoBot(ownerId: string): MockApp {
  const app = createApplication(ownerId, "Echo", "Repeats what you say. Source: examples/echo-bot.");
  app.install_permissions = (Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES).toString();
  for (const body of ECHO_COMMANDS) upsert(app.id, null, validateCommand(body));
  botHandlers.set(app.id, echoBotHandler);
  return app;
}

/** Test/demo hook: adds the seeded Echo bot to a server (emits like the authorize flow). Returns the application id. */
export function installEchoBot(guildId: string): string {
  const app = [...apps.applications.values()].find(a => a.name === "Echo");
  if (!app) throw new Error("the Echo app is not seeded");
  // Discord's default @everyone includes USE_APPLICATION_COMMANDS; the client's DEFAULT_EVERYONE does not, so grant it here.
  const guild = db.guilds.get(guildId);
  const everyone = guild?.guild.roles.find(r => r.id === guildId);
  if (everyone) everyone.permissions = (parseBits(everyone.permissions) | Perm.USE_APPLICATION_COMMANDS).toString();
  if (guild && everyone) emit(guild.members.keys(), "GUILD_ROLE_UPDATE", { guild_id: guildId, role: { ...everyone } });
  if (!guild?.members.has(app.id)) addBotToGuild(app, guildId, app.owner_id, Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES);
  return app.id;
}

export type { User };
