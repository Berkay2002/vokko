// Who controls media in a call (docs/api.md "Who controls media in a call"), shared by the Watch Together, Stremio and Spotify
// mocks: controllers, listeners, the skip vote and the host moving on, as the server's voice/control.rs does it.

import { Perm, hasBit } from "../permissions";
import type { MediaControl } from "../types";
import { channelPermsOf } from "./access";
import type { MockChannel } from "./db";
import { invalid } from "./accounts";
import { fail, MISSING_PERMISSIONS } from "./ops";
import { voiceStates } from "./voice";

/** `max(1, ceil(listeners / 2))`. */
export const skipNeeded = (listeners: number): number => Math.max(1, Math.ceil(listeners / 2));

/** People in the channel's voice who are neither self- nor server-deafened. */
export const listeners = (channelId: string): string[] =>
  [...voiceStates.values()].filter(s => s.channel_id === channelId && !s.self_deaf && !s.deaf).map(s => s.user_id);

/** In a DM call, holds CONTROL_MEDIA in the channel, or hosts the session. */
export const controls = (channel: MockChannel, userId: string, hostId: string): boolean =>
  !channel.guild_id || userId === hostId || hasBit(channelPermsOf(channel, userId), Perm.CONTROL_MEDIA);

export function requireControl(channel: MockChannel, userId: string, hostId: string): void {
  if (!controls(channel, userId, hostId)) fail(403, 50013, MISSING_PERMISSIONS);
}

/** A fresh control block for a new item: no votes yet. `added_by` is always set (undefined while nothing plays) so spreading it
 * over an old state clears the old adder. */
export const freshControl = (channelId: string, hostId: string, addedBy: string | undefined): MediaControl => ({
  host_id: hostId,
  added_by: addedBy,
  skip_votes: [],
  skip_needed: skipNeeded(listeners(channelId).length),
});

/** Same host, new current item: votes go. */
export const nextItem = (channelId: string, control: MediaControl, addedBy: string | undefined): MediaControl => freshControl(channelId, control.host_id, addedBy);

/** Drops votes of people who stopped listening, moves the host off someone who left (to whoever has been in the call longest),
 * recounts. `passed` is true when the votes now reach the threshold. */
export function recount(channelId: string, control: MediaControl): { control: MediaControl; passed: boolean } {
  const here = listeners(channelId);
  const inCall = [...voiceStates.values()].filter(s => s.channel_id === channelId).sort((a, b) => Date.parse(a.connected_at) - Date.parse(b.connected_at));
  const host = inCall.some(s => s.user_id === control.host_id) ? control.host_id : (inCall[0]?.user_id ?? control.host_id);
  const next: MediaControl = { ...control, host_id: host, skip_votes: control.skip_votes.filter(id => here.includes(id)), skip_needed: skipNeeded(here.length) };
  return { control: next, passed: next.skip_votes.length > 0 && next.skip_votes.length >= next.skip_needed };
}

/**
 * `skip: true|false` from `userId`: "skip" when a controller or the current item's adder asks (or a vote reaches the threshold),
 * else the control block with the vote added or withdrawn.
 */
export function skipOrVote(channel: MockChannel, userId: string, control: MediaControl, skip: boolean): { skip: true } | { skip: false; control: MediaControl } {
  if (skip && (controls(channel, userId, control.host_id) || control.added_by === userId)) return { skip: true };
  const votes = control.skip_votes.filter(id => id !== userId);
  if (skip) votes.push(userId);
  const counted = recount(channel.id, { ...control, skip_votes: votes });
  return counted.passed ? { skip: true } : { skip: false, control: counted.control };
}

/** 400 50035 `queue_add` when a non-controller already holds `perUser` entries. */
export function requireQuota(channel: MockChannel, userId: string, hostId: string, addedBy: string[], perUser: number): void {
  if (controls(channel, userId, hostId)) return;
  if (addedBy.filter(id => id === userId).length >= perUser) {
    invalid("queue_add", `You can have at most ${perUser} entries in the queue at once.`);
  }
}

/** The fields of a state that belong to the control block. */
export const controlOf = (state: MediaControl): MediaControl => ({
  host_id: state.host_id,
  ...(state.added_by ? { added_by: state.added_by } : {}),
  skip_votes: [...state.skip_votes],
  skip_needed: state.skip_needed,
});
