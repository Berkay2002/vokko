import { shownActivity } from "../activity/format";
import type { Activity, Channel, Guild, Presence, Relationship, Snowflake, VoiceState } from "../api/types";
import { RelationshipType } from "../api/types";

export interface ActiveEntry {
  relationship: Relationship;
  /** Subtitle: where the friend is talking, else their custom status; empty on a game card, which shows `activity`. */
  text: string;
  voice: boolean;
  /** The game they are playing (else the song on Spotify), shown on its own card and under the voice channel. */
  activity: Activity | null;
  /** The voice channel they are in (voice cards only): its members and the Join button. */
  channel: Channel | null;
  /** The channel's server when it is in our store, i.e. one we share; null for DM calls. */
  guild: Guild | null;
}

const rank = (entry: ActiveEntry) => (entry.voice ? 0 : entry.activity ? 1 : 2);

/** Friends with something to show in the Active Now column: in a voice channel first, then playing a game, then a custom status. */
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
    const presence = presences[relationship.id];
    // the server already hides both while offline or invisible; the mock does not
    const shown = presence && presence.status !== "offline" && presence.status !== "invisible" ? presence : undefined;
    const activity = shownActivity(shown);
    const state = voice[relationship.id];
    const channel = state?.channel_id ? channels[state.channel_id] : undefined;
    if (channel) {
      const guild = channel.guild_id ? guilds[channel.guild_id] : undefined;
      out.push({ relationship, text: `In ${channel.name ?? "a call"}${guild ? ` · ${guild.name}` : ""}`, voice: true, activity, channel, guild: guild ?? null });
      continue;
    }
    const custom = shown?.custom_status;
    if (activity) out.push({ relationship, text: "", voice: false, activity, channel: null, guild: null });
    else if (custom) out.push({ relationship, text: custom, voice: false, activity: null, channel: null, guild: null });
  }
  return out.sort((a, b) => rank(a) - rank(b));
}
