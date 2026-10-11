import { Perm, hasBit, parseBits } from "../api/permissions";
import { OverwriteType, type Channel, type Snowflake } from "../api/types";

/** True when the channel's @everyone overwrite denies VIEW_CHANNEL (show a lock instead of # in the sidebar row and header). */
export function isPrivateChannel(channel: Pick<Channel, "permission_overwrites"> | null | undefined, guildId: Snowflake | null | undefined): boolean {
  if (!channel || !guildId) return false;
  const everyone = channel.permission_overwrites?.find(o => o.type === OverwriteType.Role && o.id === guildId);
  return !!everyone && hasBit(parseBits(everyone.deny), Perm.VIEW_CHANNEL);
}
