// Permission lookups against the mock database (resolver lives in ../permissions).

import { ALL_PERMISSIONS, Perm, channelPermissions, hasBit, threadPermissions } from "../permissions";
import { ChannelType, isThreadType } from "../types";
import { db, type MockChannel } from "./db";

/** Guild-level permissions of a member, timeout mask included (0n for non-members). */
export function guildPermsOf(guildId: string, userId: string): bigint {
  const guild = db.guilds.get(guildId);
  const member = guild?.members.get(userId);
  if (!guild || !member) return 0n;
  return channelPermissions(guild.guild, { id: userId, roles: member.roles, communication_disabled_until: member.communication_disabled_until }, null);
}

/** A thread resolves to its parent's permissions with SEND_MESSAGES_IN_THREADS standing in for SEND_MESSAGES; a private one is hidden from non-members without MANAGE_THREADS. */
function threadPermsOf(thread: MockChannel, userId: string): bigint {
  const parent = thread.parent_id ? db.channels.get(thread.parent_id) : undefined;
  if (!parent) return 0n;
  const parentBits = channelPermsOf(parent, userId);
  if (!hasBit(parentBits, Perm.VIEW_CHANNEL)) return 0n;
  if (thread.type === ChannelType.PrivateThread && !thread.thread_members?.has(userId) && !hasBit(parentBits, Perm.MANAGE_THREADS)) return 0n;
  return threadPermissions(parentBits);
}

/** Channel-level permissions. Guild channels use the resolver; DM participants get everything a DM needs. */
export function channelPermsOf(channel: MockChannel, userId: string): bigint {
  if (isThreadType(channel.type)) return threadPermsOf(channel, userId);
  if (!channel.guild_id) return channel.participant_ids?.includes(userId) ? ALL_PERMISSIONS : 0n;
  const guild = db.guilds.get(channel.guild_id);
  const member = guild?.members.get(userId);
  if (!guild || !member) return 0n;
  return channelPermissions(guild.guild, { id: userId, roles: member.roles, communication_disabled_until: member.communication_disabled_until }, channel);
}

export const canView = (channel: MockChannel, userId: string): boolean => hasBit(channelPermsOf(channel, userId), Perm.VIEW_CHANNEL);
