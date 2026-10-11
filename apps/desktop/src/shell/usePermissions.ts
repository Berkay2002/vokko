import { useMemo } from "react";
import { useStore } from "../api/store";
import { Perm, basePermissions, canModerate, channelPermissions, hasBit, memberLike, type ModerationAction } from "../api/permissions";
import type { Snowflake } from "../api/types";

/** The viewer's permissions in a guild (and optionally a channel). Hide UI that `can()` rejects; the server stays authoritative. */
export function usePermissions(guildId: Snowflake | null | undefined, channelId?: Snowflake | null) {
  const guild = useStore(s => (guildId ? s.guilds[guildId] : undefined));
  const meId = useStore(s => s.me?.id);
  const member = useStore(s => (guildId && meId ? s.members[guildId]?.[meId] : undefined));
  const channel = useStore(s => (channelId ? s.channels[channelId] : undefined));
  return useMemo(() => {
    if (!guild || !meId) return { bits: 0n, can: (_permission: bigint) => false, isOwner: false };
    const actor = { id: meId, roles: member?.roles ?? [], communication_disabled_until: member?.communication_disabled_until };
    const bits = channel ? channelPermissions(guild, actor, channel) : basePermissions(guild, actor);
    return { bits, can: (permission: bigint) => hasBit(bits, permission), isOwner: guild.owner_id === meId };
  }, [guild, meId, member, channel]);
}

/** Which moderation actions the viewer may apply to `userId` in the guild. */
export function useModerationRights(guildId: Snowflake | null | undefined, userId: Snowflake): Record<ModerationAction, boolean> & { any: boolean } {
  const guild = useStore(s => (guildId ? s.guilds[guildId] : undefined));
  const meId = useStore(s => s.me?.id);
  const actorMember = useStore(s => (guildId && meId ? s.members[guildId]?.[meId] : undefined));
  const targetMember = useStore(s => (guildId ? s.members[guildId]?.[userId] : undefined));
  return useMemo(() => {
    const none = { kick: false, ban: false, timeout: false, nickname: false, roles: false, any: false };
    if (!guild || !meId || !targetMember) return none;
    const actor = { id: meId, roles: actorMember?.roles ?? [], communication_disabled_until: actorMember?.communication_disabled_until };
    const target = memberLike(targetMember);
    const rights = {
      kick: canModerate(guild, actor, target, "kick"),
      ban: canModerate(guild, actor, target, "ban"),
      timeout: canModerate(guild, actor, target, "timeout") && !hasBit(basePermissions(guild, target), Perm.ADMINISTRATOR),
      nickname: canModerate(guild, actor, target, "nickname"),
      roles: canModerate(guild, actor, target, "roles"),
    };
    return { ...rights, any: Object.values(rights).some(Boolean) };
  }, [guild, meId, actorMember, targetMember]);
}
