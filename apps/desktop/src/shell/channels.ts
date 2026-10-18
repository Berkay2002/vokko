import { compareIds } from "../api/snowflake";
import { ChannelType, type Channel, type Snowflake } from "../api/types";

export interface CategoryGroup {
  /** null for channels that sit above every category. */
  category: Channel | null;
  channels: Channel[];
}

const byPosition = (a: Channel, b: Channel) => a.position - b.position || compareIds(a.id, b.id);

/** Guild channels grouped like Discord's sidebar: uncategorised first, then categories by position; text before voice inside a category. */
export function groupChannels(channels: Channel[]): CategoryGroup[] {
  const categories = channels.filter(c => c.type === ChannelType.GuildCategory).sort(byPosition);
  const rest = channels.filter(c => c.type !== ChannelType.GuildCategory);
  const order = (list: Channel[]) => [...list.filter(c => c.type !== ChannelType.GuildVoice).sort(byPosition), ...list.filter(c => c.type === ChannelType.GuildVoice).sort(byPosition)];
  const groups: CategoryGroup[] = [];
  const known = new Set(categories.map(c => c.id));
  const loose = rest.filter(c => !c.parent_id || !known.has(c.parent_id));
  if (loose.length > 0) groups.push({ category: null, channels: order(loose) });
  for (const category of categories) groups.push({ category, channels: order(rest.filter(c => c.parent_id === category.id)) });
  return groups;
}

/** First text channel in sidebar order: where opening a guild lands by default. */
export function firstTextChannel(channels: Channel[]): Channel | undefined {
  for (const group of groupChannels(channels)) {
    const found = group.channels.find(c => c.type === ChannelType.GuildText);
    if (found) return found;
  }
  return undefined;
}

/** Text, announcement and forum names are slugs (lowercase, spaces become dashes); voice, stage and category names keep what was typed. */
export function channelNameFor(type: ChannelType, name: string): string {
  const slugged = type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement || type === ChannelType.GuildForum;
  return slugged ? name.trim().toLowerCase().replace(/\s+/g, "-") : name.trim();
}

export function isTextChannel(channel: Channel | undefined, id?: Snowflake): boolean {
  return !!channel && channel.type === ChannelType.GuildText && (id === undefined || channel.id === id);
}
