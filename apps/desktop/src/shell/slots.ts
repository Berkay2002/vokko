import type { ComponentType } from "react";
import type { Channel } from "../api/types";

/**
 * Extension points of the channel view that other feature folders fill in without editing the shell: `src/search/index.ts`
 * calls `registerChannelSlots({...})` once at import time (and `main.tsx` imports that module). Slots are read at render
 * time and are static after start-up, so reading `useRightPanelOpen` unconditionally in a component keeps hook order stable.
 */
export interface ChannelSlots {
  /** Replaces the header's search box. Renders the `.header-search` / `.header-search-input` markup so the shell CSS applies. */
  HeaderSearch?: ComponentType<{ channel: Channel }>;
  /** A fixed-width panel in the channel body, to the right of the chat (same column as the member list / DM profile panel). */
  RightPanel?: ComponentType<{ channel: Channel }>;
  /** True while `RightPanel` is showing for this channel; the member list and the DM profile panel step aside then. */
  useRightPanelOpen?: (channelId: string) => boolean;
}

export const channelSlots: ChannelSlots = {};

export function registerChannelSlots(slots: ChannelSlots): void {
  Object.assign(channelSlots, slots);
}

const never = (): boolean => false;

/** `channelSlots.useRightPanelOpen` or a constant false; call it unconditionally. */
export function useRightPanelOpen(channelId: string): boolean {
  return (channelSlots.useRightPanelOpen ?? never)(channelId);
}
