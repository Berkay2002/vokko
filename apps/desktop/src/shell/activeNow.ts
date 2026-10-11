import type { Channel, Guild, Presence, Relationship, Snowflake, VoiceState } from "../api/types";
import { RelationshipType } from "../api/types";

export interface ActiveEntry {
  relationship: Relationship;
  /** Subtitle: where the friend is talking, else their custom status. */
  text: string;
  voice: boolean;
}

/** Friends with something to show in the Active Now column: sitting in a voice channel (first) or a custom status. */
export function activeFriends(
  relationships: Record<Snowflake, Relationship>,
  presences: Record<Snowflake, Presence>,
  voice: Record<Snowflake, VoiceState>,
  channels: Record<Snowflake, Channel>,
  guilds: Record<Snowflake, Guild>,
): ActiveEntry[] {
  const out: ActiveEntry[] = [];
  for (const relationship of Object.values(relationships)) {
    if (relationship.type !== RelationshipType.Friend) continue;
    const state = voice[relationship.id];
    const channel = state?.channel_id ? channels[state.channel_id] : undefined;
    if (channel) {
      const guild = channel.guild_id ? guilds[channel.guild_id] : undefined;
      out.push({ relationship, text: `In ${channel.name ?? "a call"}${guild ? ` · ${guild.name}` : ""}`, voice: true });
      continue;
    }
    const custom = presences[relationship.id]?.custom_status;
    if (custom) out.push({ relationship, text: custom, voice: false });
  }
  return out.sort((a, b) => Number(b.voice) - Number(a.voice));
}
