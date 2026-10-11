// Which channel a cover upload goes through: uploads are per channel and need VIEW_CHANNEL + ATTACH_FILES there.

import { ChannelType, type Channel, type Guild, type Snowflake } from "../api/types";
import { Perm, channelPermissions, hasBit } from "./shell";

type Actor = { id: Snowflake; roles: Snowflake[]; communication_disabled_until?: string | null };

const KINDS = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice];

/**
 * The first channel of the guild (text and announcement channels before voice ones, then by position) where `actor` may upload files,
 * or undefined when there is none. The first text channel alone is not enough: it may deny ATTACH_FILES while another one allows it.
 */
export function pickUploadChannel(guild: Pick<Guild, "id" | "owner_id" | "roles">, actor: Actor, channels: Channel[], now = Date.now()): Snowflake | undefined {
  const wanted = Perm.VIEW_CHANNEL | Perm.ATTACH_FILES;
  return channels
    .filter(channel => channel.guild_id === guild.id && KINDS.includes(channel.type))
    .sort((a, b) => Number(a.type === ChannelType.GuildVoice) - Number(b.type === ChannelType.GuildVoice) || a.position - b.position)
    .find(channel => hasBit(channelPermissions(guild, actor, channel, now), wanted))?.id;
}
