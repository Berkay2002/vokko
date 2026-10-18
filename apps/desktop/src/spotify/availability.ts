// Where Spotify can be started (docs/api.md "Spotify in calls"): the house account is its owner's, so the server allows it only in
// guilds whose `features` carry VOKKO_SPOTIFY and in DM calls the owner (READY `spotify_owner_id`) is in. The server decides; this
// only hides the Activities entry where it would be refused.

import type { Snowflake } from "../api/types";

export const SPOTIFY_FEATURE = "VOKKO_SPOTIFY";

let ownerId: Snowflake | null = null;
export function setSpotifyOwner(id: Snowflake | null | undefined): void {
  ownerId = id ?? null;
}

export function spotifyAvailable(input: { dm: boolean; features: readonly string[] | undefined; inCall: readonly Snowflake[] }, owner: Snowflake | null = ownerId): boolean {
  if (!input.dm) return input.features?.includes(SPOTIFY_FEATURE) ?? false;
  return owner !== null && input.inCall.includes(owner);
}
