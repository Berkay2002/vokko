// Permission lookups against the mock database (resolver lives in ../permissions).

import { ALL_PERMISSIONS, Perm, channelPermissions, hasBit } from "../permissions";
import { db, type MockChannel } from "./db";

/** Guild-level permissions of a member, timeout mask included (0n for non-members). */
export function guildPermsOf(guildId: string, userId: string): bigint {
  const guild = db.guilds.get(guildId);
  const member = guild?.members.get(userId);
  if (!guild || !member) return 0n;
  return channelPermissions(guild.guild, { id: userId, roles: member.roles, communication_disabled_until: member.communication_disabled_until }, null);
}

/** Channel-level permissions. Guild channels use the resolver; DM participants get everything a DM needs. */
export function channelPermsOf(channel: MockChannel, userId: string): bigint {
  if (!channel.guild_id) return channel.participant_ids?.includes(userId) ? ALL_PERMISSIONS : 0n;
  const guild = db.guilds.get(channel.guild_id);
  const member = guild?.members.get(userId);
  if (!guild || !member) return 0n;
  return channelPermissions(guild.guild, { id: userId, roles: member.roles, communication_disabled_until: member.communication_disabled_until }, channel);
}

export const canView = (channel: MockChannel, userId: string): boolean => hasBit(channelPermsOf(channel, userId), Perm.VIEW_CHANNEL);
