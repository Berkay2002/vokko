import { ChannelType, type Channel, type Snowflake } from '../api/types';

export type MentionKind = 'user' | 'role' | 'channel';

export type MentionTarget =
  | { type: 'profile'; userId: Snowflake; guildId: Snowflake | null }
  | { type: 'channel'; channel: Channel };

export interface MentionLookups {
  /** Guild the mention is rendered in (null in a DM). */
  guildId: Snowflake | null;
  /** Channels of that guild; a mention of anything else renders as unknown and has no target. */
  channels: readonly Channel[];
  hasUser(id: Snowflake): boolean;
}

/**
 * Where a click on a mention chip goes. null when there is nowhere to go: an unknown user or channel (the chip is a plain pill),
 * a category, and roles (the app has no role popout; the chip keeps its hover look and the click does nothing).
 */
export function mentionTarget(kind: MentionKind, id: Snowflake, env: MentionLookups): MentionTarget | null {
  if (kind === 'user') return env.hasUser(id) ? { type: 'profile', userId: id, guildId: env.guildId } : null;
  if (kind === 'channel') {
    const channel = env.channels.find(c => c.id === id);
    return channel && channel.type !== ChannelType.GuildCategory ? { type: 'channel', channel } : null;
  }
  return null;
}
