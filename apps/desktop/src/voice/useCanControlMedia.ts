// Who controls Watch Together, Stremio and Spotify in a call (docs/api.md "Who controls media in a call"). The server decides;
// this only picks which controls a tile shows: a controller is in a DM call, holds CONTROL_MEDIA in the channel, or hosts the session.

import { Perm, hasBit } from "../api/permissions";
import { useStore } from "../api/store";
import type { MediaControl, Snowflake } from "../api/types";
import { usePermissions } from "../shell/usePermissions";

export function canControlMedia(input: { dm: boolean; bits: bigint; meId: Snowflake | undefined; hostId: Snowflake | undefined }): boolean {
  return input.dm || hasBit(input.bits, Perm.CONTROL_MEDIA) || (!!input.meId && input.meId === input.hostId);
}

export function useCanControlMedia(channelId: Snowflake, hostId: Snowflake | undefined): boolean {
  const guildId = useStore(s => s.channels[channelId]?.guild_id ?? null);
  const meId = useStore(s => s.me?.id);
  const { bits } = usePermissions(guildId, channelId);
  return canControlMedia({ dm: !guildId, bits, meId, hostId });
}

export const useMeId = (): Snowflake | undefined => useStore(s => s.me?.id);

export interface SkipAction {
  label: string; // the button's name, e.g. "Vote to skip (1/3)"
  vote: boolean; // pressing it votes (or withdraws) instead of skipping
  voted: boolean;
  skip: boolean; // what to send as `skip`
}

/** What the Skip button says and sends: a controller and the current item's adder skip at once, everyone else votes (again to withdraw). */
export function skipAction(control: MediaControl, meId: Snowflake | undefined, controller: boolean, skipLabel = "Skip"): SkipAction {
  const votes = control.skip_votes.length;
  if (controller || (!!meId && control.added_by === meId)) return { label: votes ? `${skipLabel}, ${votes} voted` : skipLabel, vote: false, voted: false, skip: true };
  const voted = !!meId && control.skip_votes.includes(meId);
  return { label: `Vote to skip (${votes}/${control.skip_needed})`, vote: true, voted, skip: !voted };
}

/** A non-controller's own queue entries against the per-user quota; null for a controller (only the queue max applies). */
export function queueQuota(addedBy: readonly Snowflake[], meId: Snowflake | undefined, controller: boolean, perUser: number): { mine: number; full: boolean; hint: string } | null {
  if (controller) return null;
  const mine = addedBy.filter(id => id === meId).length;
  return { mine, full: mine >= perUser, hint: `${Math.min(mine, perUser)} of ${perUser} added` };
}
