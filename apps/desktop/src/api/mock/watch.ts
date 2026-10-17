// Mock Watch Together (docs/api.md "Voice (V1)"): PUT / PATCH / DELETE /channels/{id}/watch-together and WATCH_TOGETHER_UPDATE,
// in memory per channel like the server. Who may do what is mediaControl.ts (controllers, votes, quota); the session ends when
// the last person leaves (voice.ts releaseChannel calls `endWatch`).

import {
  WATCH_TOGETHER_POSITION_MAX_MS,
  WATCH_TOGETHER_QUEUE_MAX,
  WATCH_TOGETHER_QUEUE_PER_USER,
  type WatchTogetherPatchRequest,
  type WatchTogetherState,
  type WatchTogetherUpdate,
} from "../types";
import { canView } from "./access";
import { db, type MockChannel } from "./db";
import { controls, freshControl, nextItem, recount, requireControl, requireQuota, skipOrVote } from "./mediaControl";
import { fail, MISSING_PERMISSIONS, requireChannel } from "./ops";
import { ID, route, str } from "./router";
import { emit } from "./socket";
import { voiceAudience, voiceStates } from "./voice";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const TITLE_MAX = 200;
/** Controls and invisible characters (zero-width, bidi, soft hyphen, fillers) a broadcast title may not carry. */
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u001f\u007f-\u009f­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯⠀ㅤ︀-️﻿ﾠ￹-￻]/;

const sessions = new Map<string, WatchTogetherState>();
const copy = (state: WatchTogetherState): WatchTogetherState => ({ ...state, queue: [...state.queue], queue_added_by: [...state.queue_added_by], skip_votes: [...state.skip_votes] });

const invalid = (field: string, message: string): never => fail(400, 50035, "Invalid Form Body", { [field]: { code: "INVALID", message } });

export const watchOf = (channelId: string): WatchTogetherState | undefined => sessions.get(channelId);

/** Sessions in the guild's voice channels `viewerId` can see (READY / GUILD_CREATE). */
export function watchFor(guildId: string, viewerId: string): WatchTogetherUpdate[] {
  return [...sessions.entries()].flatMap(([channelId, state]) => {
    const channel = db.channels.get(channelId);
    return channel && channel.guild_id === guildId && canView(channel, viewerId) ? [{ channel_id: channelId, state: copy(state) }] : [];
  });
}

function announce(channel: MockChannel, state: WatchTogetherState | null): void {
  emit(voiceAudience(channel), "WATCH_TOGETHER_UPDATE", { channel_id: channel.id, state: state && copy(state) });
}

function videoId(field: string, value: unknown): string {
  if (typeof value !== "string" || !VIDEO_ID.test(value)) return invalid(field, "Must be a YouTube video id (11 characters of A-Z a-z 0-9 _ -).");
  return value;
}

function title(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = (str(value) ?? invalid("title", "Must be a string.")).trim();
  if ([...text].length > TITLE_MAX) invalid("title", `Must be ${TITLE_MAX} or fewer in length.`);
  if (HIDDEN.test(text)) invalid("title", "Must not contain control or invisible characters.");
  return text || undefined;
}

function connectedChannel(viewerId: string, channelId: string): MockChannel {
  const channel = requireChannel(channelId, viewerId);
  if (voiceStates.get(viewerId)?.channel_id !== channel.id) fail(403, 50013, MISSING_PERMISSIONS);
  return channel;
}

route("PUT", `/channels/${ID}/watch-together`, ({ viewer, params, body }) => {
  const channel = connectedChannel(viewer.user.id, params[0] ?? "");
  const id = videoId("video_id", body.video_id);
  const current = sessions.get(channel.id);
  // Starting is open to everyone in the call; replacing a running video is a controller's.
  if (current) requireControl(channel, viewer.user.id, current.host_id);
  const next: WatchTogetherState = {
    video_id: id,
    title: title(body.title),
    playing: true,
    position_ms: 0,
    updated_at_ms: Date.now(),
    started_by: current?.started_by ?? viewer.user.id,
    queue: current?.queue ?? [],
    queue_added_by: current?.queue_added_by ?? [],
    ...freshControl(channel.id, current?.host_id ?? viewer.user.id, viewer.user.id, current ? current.item_seq + 1 : 0),
  };
  if (!next.title) delete next.title;
  sessions.set(channel.id, next);
  announce(channel, next);
  return copy(next);
});

route("PATCH", `/channels/${ID}/watch-together`, ({ viewer, params, body }) => {
  const channel = connectedChannel(viewer.user.id, params[0] ?? "");
  const patch = body as WatchTogetherPatchRequest;
  if (patch.position_ms !== undefined && (!Number.isInteger(patch.position_ms) || patch.position_ms < 0 || patch.position_ms > WATCH_TOGETHER_POSITION_MAX_MS)) {
    invalid("position_ms", "Must be between 0 and 86400000.");
  }
  const added = patch.queue_add === undefined ? undefined : videoId("queue_add", patch.queue_add);
  const expected = patch.video_id === undefined ? undefined : videoId("video_id", patch.video_id);
  const newTitle = title(patch.title);
  const before = sessions.get(channel.id);
  if (!before) return fail(400, 40033, "Nothing is playing in this channel.");
  const now = Date.now();
  const next = copy(before);
  const here = next.playing ? next.position_ms + Math.max(0, now - next.updated_at_ms) : next.position_ms;
  const controller = controls(channel, viewer.user.id, before.host_id);
  if (!controller && (patch.playing !== undefined || patch.position_ms !== undefined)) fail(403, 50013, MISSING_PERMISSIONS);
  if (patch.skip !== undefined) {
    if (expected !== undefined && expected !== next.video_id) return copy(before);
    const outcome = skipOrVote(channel, viewer.user.id, before, patch.skip === true);
    if (!outcome.skip) Object.assign(next, outcome.control);
    else if (!advance(channel, next, now)) return null;
  } else if (patch.playing !== undefined || patch.position_ms !== undefined) {
    next.position_ms = patch.position_ms ?? here;
    next.playing = patch.playing ?? next.playing;
    next.updated_at_ms = now;
  }
  // Anyone fills in a missing title (the clients' auto-fill); replacing one is a controller's, else a silent no-op as on the server.
  if (newTitle && (controller || !before.title)) next.title = newTitle;
  // Anyone takes back their own entry, controllers any; a stale index (the queue moved) is a no-op.
  const remove = patch.queue_remove;
  if (remove && Number.isInteger(remove.index) && remove.index >= 0 && next.queue[remove.index] === remove.video_id) {
    if (!controller && next.queue_added_by[remove.index] !== viewer.user.id) fail(403, 50013, MISSING_PERMISSIONS);
    next.queue.splice(remove.index, 1);
    next.queue_added_by.splice(remove.index, 1);
  }
  if (added !== undefined) {
    if (next.queue.length >= WATCH_TOGETHER_QUEUE_MAX) invalid("queue_add", `The queue holds at most ${WATCH_TOGETHER_QUEUE_MAX} videos.`);
    requireQuota(channel, viewer.user.id, before.host_id, next.queue_added_by, WATCH_TOGETHER_QUEUE_PER_USER);
    next.queue.push(added);
    next.queue_added_by.push(viewer.user.id);
  }
  sessions.set(channel.id, next);
  if (JSON.stringify(next) !== JSON.stringify(before)) announce(channel, next);
  return copy(next);
});

/** Moves `next` on to the first queued video; false (and the session ended) when the queue is empty. */
function advance(channel: MockChannel, next: WatchTogetherState, now: number): boolean {
  const upNext = next.queue.shift();
  const adder = next.queue_added_by.shift();
  if (upNext === undefined) {
    sessions.delete(channel.id);
    announce(channel, null);
    return false;
  }
  Object.assign(next, { video_id: upNext, playing: true, position_ms: 0, updated_at_ms: now }, nextItem(channel.id, next, adder));
  delete next.title;
  return true;
}

route("DELETE", `/channels/${ID}/watch-together`, ({ viewer, params }) => {
  const channel = connectedChannel(viewer.user.id, params[0] ?? "");
  const current = sessions.get(channel.id);
  if (current) requireControl(channel, viewer.user.id, current.host_id);
  endWatch(channel.id);
  return undefined;
});

/** Someone joined, left or (un)deafened in `channelId`: votes, the threshold and the host follow, and a vote that now passes skips. */
export function recountWatch(channelId: string): void {
  const before = sessions.get(channelId);
  const channel = db.channels.get(channelId);
  if (!before || !channel) return;
  const counted = recount(channelId, before);
  const next = { ...copy(before), ...counted.control };
  if (counted.passed && !advance(channel, next, Date.now())) return;
  if (JSON.stringify(next) === JSON.stringify(before)) return;
  sessions.set(channelId, next);
  announce(channel, next);
}

/** The session of `channelId` ends (stop, or nobody is left in voice). */
export function endWatch(channelId: string): void {
  if (!sessions.delete(channelId)) return;
  const channel = db.channels.get(channelId);
  if (channel) announce(channel, null);
}
