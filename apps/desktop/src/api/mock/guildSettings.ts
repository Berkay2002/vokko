// Mock of GET/PATCH /users/@me/guilds/{guild.id|@me}/settings and USER_GUILD_SETTINGS_UPDATE (docs/api.md "Notification settings").

import { UNREADS_ONLY_MENTIONS, type ChannelOverride, type MuteConfig, type UserGuildSettings } from "../types";
import { db } from "./db";
import { fail } from "./ops";
import { route } from "./router";
import { emit } from "./socket";

const MAX_OVERRIDES = 500;
/** `${userId}:${guildId}`, guild "@me" for DMs. */
const saved = new Map<string, UserGuildSettings>();

const invalid = (field: string, message: string): never => fail(400, 50035, "Invalid Form Body", { [field]: { _errors: [{ code: "INVALID", message }] } });

export const defaultGuildSettings = (guildId: string | null): UserGuildSettings => ({
  guild_id: guildId,
  muted: false,
  mute_config: null,
  message_notifications: 3,
  flags: 0,
  suppress_everyone: false,
  suppress_roles: false,
  hide_muted_channels: false,
  channel_overrides: [],
});

/** READY `user_guild_settings`: DMs and the guilds the user is still in. */
export function guildSettingsFor(userId: string): UserGuildSettings[] {
  return [...saved.entries()]
    .filter(([key, entry]) => key.startsWith(`${userId}:`) && (entry.guild_id === null || db.guilds.get(entry.guild_id)?.members.has(userId)))
    .map(([, entry]) => structuredClone(entry));
}

/** The user's two Suppress switches for a guild (both off for DMs and guilds without saved settings). */
export function suppressionOf(userId: string, guildId: string | null): { everyone: boolean; roles: boolean } {
  const settings = guildId ? saved.get(`${userId}:${guildId}`) : undefined;
  return { everyone: !!settings?.suppress_everyone, roles: !!settings?.suppress_roles };
}

function target(guild: string, userId: string): string | null {
  if (guild === "@me") return null;
  if (!db.guilds.get(guild)?.members.has(userId)) fail(404, 10004, "Unknown Guild");
  return guild;
}

const current = (userId: string, guildId: string | null): UserGuildSettings =>
  structuredClone(saved.get(`${userId}:${guildId ?? "@me"}`) ?? defaultGuildSettings(guildId));

function checkLevel(field: string, level: unknown, flags: unknown): void {
  if (level !== undefined && (typeof level !== "number" || ![0, 1, 2, 3].includes(level))) invalid(field, "Must be 0, 1, 2 or 3.");
  if (flags !== undefined && (typeof flags !== "number" || (flags & ~UNREADS_ONLY_MENTIONS) !== 0)) invalid(field, "Unknown flag bits.");
}

function checkMuteConfig(config: unknown): void {
  const end = (config as MuteConfig | null | undefined)?.end_time;
  if (end != null && Number.isNaN(Date.parse(end))) invalid("mute_config", "Must be an ISO 8601 timestamp.");
}

type Patch = Partial<Omit<UserGuildSettings, "guild_id" | "channel_overrides">> & { channel_overrides?: Record<string, Partial<ChannelOverride>> };

route("GET", "/users/@me/guilds/(\\d+|@me)/settings", ({ viewer, params }) => current(viewer.user.id, target(params[0] ?? "", viewer.user.id)));

route("PATCH", "/users/@me/guilds/(\\d+|@me)/settings", ({ viewer, params, body }) => {
  const guildId = target(params[0] ?? "", viewer.user.id);
  const patch = body as Patch;
  checkLevel("message_notifications", patch.message_notifications, patch.flags);
  checkMuteConfig(patch.mute_config);
  const next = current(viewer.user.id, guildId);
  for (const key of ["muted", "message_notifications", "flags", "suppress_everyone", "suppress_roles", "hide_muted_channels"] as const) {
    if (patch[key] !== undefined) (next[key] as unknown) = patch[key];
  }
  next.mute_config = next.muted ? (patch.mute_config !== undefined ? patch.mute_config : next.mute_config) : null;
  for (const [channelId, change] of Object.entries(patch.channel_overrides ?? {})) {
    checkLevel("channel_overrides", change.message_notifications, change.flags);
    checkMuteConfig(change.mute_config);
    const old = next.channel_overrides.find(o => o.channel_id === channelId);
    const merged: ChannelOverride = { channel_id: channelId, muted: false, mute_config: null, message_notifications: 3, flags: 0, collapsed: false, ...old, ...change };
    if (!merged.muted) merged.mute_config = null;
    next.channel_overrides = next.channel_overrides.filter(o => o.channel_id !== channelId);
    if (merged.muted || merged.message_notifications !== 3 || merged.flags !== 0 || merged.collapsed) next.channel_overrides.push(merged);
  }
  if (next.channel_overrides.length > MAX_OVERRIDES) invalid("channel_overrides", `At most ${MAX_OVERRIDES} channel overrides.`);
  saved.set(`${viewer.user.id}:${guildId ?? "@me"}`, next);
  emit([viewer.user.id], "USER_GUILD_SETTINGS_UPDATE", structuredClone(next));
  return next;
});
