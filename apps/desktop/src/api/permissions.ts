// Permission model (Discord bitfield, per the private client notes, Q4). Pure functions shared by the UI and the mock backend.

import { OverwriteType, isThreadType, type Channel, type Guild, type GuildMember, type Role, type Snowflake } from "./types";

/** Bit positions (Q4.2). */
export const PermBit = {
  CREATE_INSTANT_INVITE: 0,
  KICK_MEMBERS: 1,
  BAN_MEMBERS: 2,
  ADMINISTRATOR: 3,
  MANAGE_CHANNELS: 4,
  MANAGE_GUILD: 5,
  ADD_REACTIONS: 6,
  VIEW_AUDIT_LOG: 7,
  PRIORITY_SPEAKER: 8,
  STREAM: 9,
  VIEW_CHANNEL: 10,
  SEND_MESSAGES: 11,
  SEND_TTS_MESSAGES: 12,
  MANAGE_MESSAGES: 13,
  EMBED_LINKS: 14,
  ATTACH_FILES: 15,
  READ_MESSAGE_HISTORY: 16,
  MENTION_EVERYONE: 17,
  USE_EXTERNAL_EMOJIS: 18,
  USE_EXTERNAL_STICKERS: 37,
  CONNECT: 20,
  SPEAK: 21,
  MUTE_MEMBERS: 22,
  DEAFEN_MEMBERS: 23,
  MOVE_MEMBERS: 24,
  USE_VAD: 25,
  CHANGE_NICKNAME: 26,
  MANAGE_NICKNAMES: 27,
  MANAGE_ROLES: 28,
  MANAGE_WEBHOOKS: 29,
  MANAGE_GUILD_EXPRESSIONS: 30,
  USE_APPLICATION_COMMANDS: 31,
  REQUEST_TO_SPEAK: 32,
  MANAGE_EVENTS: 33,
  MANAGE_THREADS: 34,
  CREATE_PUBLIC_THREADS: 35,
  CREATE_PRIVATE_THREADS: 36,
  SEND_MESSAGES_IN_THREADS: 38,
  USE_SOUNDBOARD: 42,
  CREATE_GUILD_EXPRESSIONS: 43,
  CREATE_EVENTS: 44,
  USE_EXTERNAL_SOUNDS: 45,
  MODERATE_MEMBERS: 40,
  SET_VOICE_CHANNEL_STATUS: 48,
  SEND_POLLS: 49,
  SEND_VOICE_MESSAGES: 46,
  PIN_MESSAGES: 51,
  BYPASS_SLOWMODE: 52,
  /** Vokko-only: pause, seek, skip, stop and reorder Watch Together, Stremio and Spotify in a call (docs/design/bot-control.md). */
  CONTROL_MEDIA: 60,
} as const;

export const bit = (n: number): bigint => 1n << BigInt(n);

export const Perm = Object.fromEntries(Object.entries(PermBit).map(([name, n]) => [name, bit(n)])) as { [K in keyof typeof PermBit]: bigint };

/** Every bit Vokko knows (0..53 except the unassigned 47, plus Vokko's CONTROL_MEDIA 60). */
export const ALL_PERMISSIONS: bigint = (() => {
  let all = bit(PermBit.CONTROL_MEDIA);
  for (let i = 0; i <= 53; i += 1) if (i !== 47) all |= bit(i);
  return all;
})();

/** Q4.4 fallback @everyone set, used when a guild has no @everyone role (plus Vokko's CONTROL_MEDIA). */
export const DEFAULT_EVERYONE: bigint = [0, 26, 10, 11, 14, 15, 16, 17, 18, 37, 6, 20, 21, 25, 9, 42, 43, 44, 45, 35, 36, 38, 49, 32, 60].reduce((acc, n) => acc | bit(n), 0n);

export function parseBits(value: string | bigint | undefined | null): bigint {
  if (typeof value === "bigint") return value;
  try {
    return value ? BigInt(value) : 0n;
  } catch {
    return 0n;
  }
}

export const hasBit = (bits: bigint, permission: bigint): boolean => (bits & permission) === permission;

type GuildLike = Pick<Guild, "id" | "owner_id" | "roles">;
type MemberLike = { id: Snowflake; roles: Snowflake[]; communication_disabled_until?: string | null };

/** Role-level permissions of a member (owner and administrator shortcuts included), clamped by an active timeout (Q4.5). */
export function basePermissions(guild: GuildLike, member: MemberLike, now = Date.now()): bigint {
  if (guild.owner_id === member.id) return ALL_PERMISSIONS;
  const everyone = guild.roles.find(r => r.id === guild.id);
  let bits = everyone ? parseBits(everyone.permissions) : DEFAULT_EVERYONE;
  for (const role of guild.roles) if (role.id !== guild.id && member.roles.includes(role.id)) bits |= parseBits(role.permissions);
  if (hasBit(bits, Perm.ADMINISTRATOR)) return ALL_PERMISSIONS;
  return timedOut(member, now) ? bits & TIMEOUT_ALLOWED : bits;
}

/** What a timed-out member keeps (the server's TIMEOUT_ALLOWED); the owner and administrators are never clamped. */
const TIMEOUT_ALLOWED = Perm.VIEW_CHANNEL | Perm.READ_MESSAGE_HISTORY;

const timedOut = (member: MemberLike, now: number): boolean =>
  !!member.communication_disabled_until && Date.parse(member.communication_disabled_until) > now;

/** Channel-level permissions: base, then overwrites (@everyone, roles, member), then the timeout mask (Q4.5). */
export function channelPermissions(guild: GuildLike, member: MemberLike, channel?: Pick<Channel, "permission_overwrites" | "parent_id"> | null, now = Date.now()): bigint {
  let bits = basePermissions(guild, member, now);
  if (guild.owner_id === member.id || hasBit(bits, Perm.ADMINISTRATOR)) return bits;
  const overwrites = channel?.permission_overwrites ?? [];
  const everyone = overwrites.find(o => o.type === OverwriteType.Role && o.id === guild.id);
  if (everyone) bits = (bits & ~parseBits(everyone.deny)) | parseBits(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.type === OverwriteType.Role && o.id !== guild.id && member.roles.includes(o.id)) {
      allow |= parseBits(o.allow);
      deny |= parseBits(o.deny);
    }
  }
  bits = (bits & ~deny) | allow;
  const own = overwrites.find(o => o.type === OverwriteType.Member && o.id === member.id);
  if (own) bits = (bits & ~parseBits(own.deny)) | parseBits(own.allow);
  if (timedOut(member, now)) bits &= TIMEOUT_ALLOWED;
  return bits;
}

/**
 * Permissions inside a thread: the parent channel's resolved bits with SEND_MESSAGES replaced by SEND_MESSAGES_IN_THREADS
 * (the thread's own SEND_MESSAGES is on exactly when the parent grants SEND_MESSAGES_IN_THREADS; the original bit stays readable).
 * Joining a private thread or being a member is a separate rule (docs/api.md, Threads, forums and announcements).
 */
export function threadPermissions(parentBits: bigint): bigint {
  const bits = parentBits & ~Perm.SEND_MESSAGES;
  return hasBit(parentBits, Perm.SEND_MESSAGES_IN_THREADS) ? bits | Perm.SEND_MESSAGES : bits;
}

/**
 * Can the member post in this channel (the composer's locked state, Reply)? A thread follows its parent's SEND_MESSAGES_IN_THREADS,
 * and a locked one also needs MANAGE_THREADS. Whatever the client has not loaded (DM or unknown guild, the member beyond the READY
 * member cap, a thread's parent) reads as true: the server is authoritative.
 */
export function canSendIn(guild: GuildLike | undefined, member: MemberLike | undefined, channel: Channel | undefined, parent?: Channel): boolean {
  if (!guild || !member || !channel) return true;
  if (!isThreadType(channel.type)) return hasBit(channelPermissions(guild, member, channel), Perm.SEND_MESSAGES);
  if (!parent) return true;
  const parentBits = channelPermissions(guild, member, parent);
  const locked = channel.thread_metadata?.locked === true;
  return hasBit(threadPermissions(parentBits), Perm.SEND_MESSAGES) && (!locked || hasBit(parentBits, Perm.MANAGE_THREADS));
}

export const rolePosition = (guild: GuildLike, roleId: Snowflake): number => guild.roles.find(r => r.id === roleId)?.position ?? 0;

/** Position of the member's highest role (0 = only @everyone). */
export function highestPosition(guild: GuildLike, roleIds: Snowflake[]): number {
  let top = 0;
  for (const role of guild.roles) if (role.id !== guild.id && roleIds.includes(role.id) && role.position > top) top = role.position;
  return top;
}

type RoleRank = Pick<Role, "id" | "position">;

/** Whether role `a` outranks role `b` (the server's compare_roles): higher position wins, a tie goes to the older (smaller) snowflake. */
const roleAbove = (a: RoleRank, b: RoleRank): boolean => a.position > b.position || (a.position === b.position && a.id !== b.id && BigInt(a.id) < BigInt(b.id));

/** The member's highest role by (position, id), ignoring @everyone; undefined when they hold none. */
export function topRole(guild: GuildLike, roleIds: Snowflake[]): RoleRank | undefined {
  let top: RoleRank | undefined;
  for (const role of guild.roles) if (role.id !== guild.id && roleIds.includes(role.id) && (!top || roleAbove(role, top))) top = role;
  return top;
}

/** Hierarchy rule for moderating a member (Q4.5 canManageUser): never the owner, owner always, otherwise strictly outrank. */
export function outranks(guild: GuildLike, actor: MemberLike, target: MemberLike): boolean {
  if (target.id === guild.owner_id) return false;
  if (actor.id === guild.owner_id) return true;
  if (target.roles.length === 0) return true;
  const mine = topRole(guild, actor.roles);
  const theirs = topRole(guild, target.roles);
  return !!mine && (!theirs || roleAbove(mine, theirs));
}

/** Can the actor create or edit a role / hand it out? Needs MANAGE_ROLES and to outrank the role (owner exempt). */
export function canEditRole(guild: GuildLike, actor: MemberLike, role: Pick<Role, "id" | "position">): boolean {
  if (!hasBit(basePermissions(guild, actor), Perm.MANAGE_ROLES)) return false;
  if (actor.id === guild.owner_id) return true;
  if (role.id === guild.id) return true;
  const mine = topRole(guild, actor.roles);
  return !!mine && roleAbove(mine, role);
}

export type ModerationAction = "kick" | "ban" | "timeout" | "nickname" | "roles";

/** Whether the actor may apply a moderation action to the target in this guild (client-side gate; the server is authoritative). */
export function canModerate(guild: GuildLike, actor: MemberLike, target: MemberLike, action: ModerationAction): boolean {
  if (actor.id === target.id) return action === "nickname" ? hasBit(basePermissions(guild, actor), Perm.CHANGE_NICKNAME) : false;
  const bits = basePermissions(guild, actor);
  const needed = { kick: Perm.KICK_MEMBERS, ban: Perm.BAN_MEMBERS, timeout: Perm.MODERATE_MEMBERS, nickname: Perm.MANAGE_NICKNAMES, roles: Perm.MANAGE_ROLES }[action];
  if (!hasBit(bits, needed)) return false;
  return outranks(guild, actor, target);
}

/** Permission names for the overwrite editor: which bits a channel overwrite may set by channel type. */
export const TEXT_OVERWRITE_BITS = [10, 4, 28, 0, 11, 14, 15, 6, 18, 17, 13, 51, 16, 12, 46, 49, 38, 35, 36, 37, 52, 34] as const;
export const VOICE_OVERWRITE_BITS = [10, 4, 28, 0, 20, 21, 9, 25, 8, 22, 23, 24, 42, 45, 48] as const;

export function memberLike(member: Pick<GuildMember, "user" | "roles"> & { communication_disabled_until?: string | null }): MemberLike {
  return { id: member.user.id, roles: member.roles, communication_disabled_until: member.communication_disabled_until };
}
