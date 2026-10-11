// Client-only voice occupancy. The v1 server contract has no voice state yet, so the shell shows who is "in" a voice
// channel from this store (seeded by the mock backend) and nothing else. Replace when voice lands in the contract.

import { create } from "zustand";
import type { Snowflake } from "./types";

interface VoiceState {
  occupants: Record<Snowflake, Snowflake[]>;
  setOccupants(channelId: Snowflake, userIds: Snowflake[]): void;
}

export const voiceStore = create<VoiceState>()(set => ({
  occupants: {},
  setOccupants: (channelId, userIds) => set(state => ({ occupants: { ...state.occupants, [channelId]: userIds } })),
}));

export function useVoiceOccupants(channelId: Snowflake): Snowflake[] {
  return voiceStore(state => state.occupants[channelId]) ?? NONE;
}

const NONE: Snowflake[] = [];
