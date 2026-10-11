// Kept for older imports: voice occupancy now comes from the voice store in src/voice (gateway voice states).

import type { Snowflake } from "./types";
import { useChannelVoiceStates } from "../voice/store";

/** User ids in a voice channel, in join order. */
export function useVoiceOccupants(channelId: Snowflake): Snowflake[] {
  const states = useChannelVoiceStates(channelId);
  return states.length === 0 ? NONE : states.map(s => s.user_id);
}

const NONE: Snowflake[] = [];
