import { channelMentionCount, isChannelUnread, type AppState } from "../api/store";
import { ChannelType, type Snowflake } from "../api/types";
import { groupChannels } from "../shell/channels";

export interface Place {
  guildId: Snowflake | null;
  channelId: Snowflake;
}

/** Channels Alt+Up/Down walks: the DM list at home, a server's text channels in sidebar order otherwise. */
export function channelOrder(s: AppState, guildId: Snowflake | null): Place[] {
  if (!guildId) return s.privateChannels.filter(id => s.channels[id]).map(channelId => ({ guildId: null, channelId }));
  return groupChannels(Object.values(s.channels).filter(c => c.guild_id === guildId))
    .flatMap(g => g.channels)
    .filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
    .map(c => ({ guildId, channelId: c.id }));
}

/** Every place in rail order: DMs, then each server's channels. */
export function allChannelOrder(s: AppState): Place[] {
  return [channelOrder(s, null), ...s.guildOrder.map(g => channelOrder(s, g))].flat();
}

/** The nearest place from `current` in direction `dir` (-1 up, 1 down) that passes `ok`; no wrap-around. */
export function step(list: Place[], current: Snowflake | null, dir: -1 | 1, ok: (p: Place) => boolean = () => true): Place | undefined {
  const at = list.findIndex(p => p.channelId === current);
  // Not in the list (a voice channel, Friends): start from the end the direction points away from.
  for (let i = at < 0 ? (dir > 0 ? 0 : list.length - 1) : at + dir; i >= 0 && i < list.length; i += dir) if (ok(list[i]!)) return list[i];
  return undefined;
}

export const unread = (s: AppState) => (p: Place) => isChannelUnread(s, p.channelId);
export const mentioned = (s: AppState) => (p: Place) => channelMentionCount(s, p.channelId) > 0;
