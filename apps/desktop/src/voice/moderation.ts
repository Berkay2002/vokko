// Stage and voice moderation actions (docs/api.md "Stage channels", "Voice"): thin REST calls; the store follows the
// VOICE_STATE_UPDATE / STAGE_INSTANCE_* / GUILD_MEMBER_UPDATE events that come back. Each rejects with the API error.

import { request } from "../api/rest";
import { appStore } from "../api/store";
import { Perm, basePermissions, channelPermissions, hasBit } from "../api/permissions";
import type { Channel, Snowflake, StageInstance } from "../api/types";

/** The viewer's permissions in a channel (or guild-wide without one); 0 when unknown. */
export function viewerBits(guildId: Snowflake, channel?: Channel | null): bigint {
  const state = appStore.getState();
  const guild = state.guilds[guildId];
  const meId = state.me?.id;
  const member = meId ? state.members[guildId]?.[meId] : undefined;
  if (!guild || !meId) return 0n;
  const actor = { id: meId, roles: member?.roles ?? [], communication_disabled_until: member?.communication_disabled_until };
  return channel ? channelPermissions(guild, actor, channel) : basePermissions(guild, actor);
}

/** Discord's stage moderator set: MANAGE_CHANNELS + MUTE_MEMBERS + MOVE_MEMBERS (administrators have all). */
export function isStageModeratorBits(bits: bigint): boolean {
  return hasBit(bits, Perm.ADMINISTRATOR) || (hasBit(bits, Perm.MANAGE_CHANNELS) && hasBit(bits, Perm.MUTE_MEMBERS) && hasBit(bits, Perm.MOVE_MEMBERS));
}

export const startStage = (channelId: Snowflake, topic: string): Promise<StageInstance> =>
  request<StageInstance>("POST", "/stage-instances", { channel_id: channelId, topic: topic.trim() });

export const editStageTopic = (channelId: Snowflake, topic: string): Promise<StageInstance> =>
  request<StageInstance>("PATCH", `/stage-instances/${channelId}`, { topic: topic.trim() });

export const endStage = (channelId: Snowflake): Promise<void> => request<void>("DELETE", `/stage-instances/${channelId}`);

/** Raise (true) or lower (false) our hand in the stage we are in. */
export const setHandRaised = (guildId: Snowflake, channelId: Snowflake, raised: boolean): Promise<void> =>
  request<void>("PATCH", `/guilds/${guildId}/voice-states/@me`, { channel_id: channelId, request_to_speak_timestamp: raised ? new Date().toISOString() : null });

/** Speaker (`false`) or audience (`true`): `@me` for ourselves (becoming a speaker needs stage moderator), a user id to invite / move. */
export const setSuppressed = (guildId: Snowflake, channelId: Snowflake, userId: Snowflake | "@me", suppress: boolean): Promise<void> =>
  request<void>("PATCH", `/guilds/${guildId}/voice-states/${userId}`, { channel_id: channelId, suppress });

/** Server mute / deafen (MUTE_MEMBERS / DEAFEN_MEMBERS), move (channel id) or disconnect (null) (MOVE_MEMBERS). */
export const editMemberVoice = (guildId: Snowflake, userId: Snowflake, body: { mute?: boolean; deaf?: boolean; channel_id?: Snowflake | null }): Promise<unknown> =>
  request("PATCH", `/guilds/${guildId}/members/${userId}`, body);
