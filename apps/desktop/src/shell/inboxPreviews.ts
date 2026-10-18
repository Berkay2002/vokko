// The newest few messages per channel for Inbox > Unreads. Each channel is fetched once (limit PREVIEW_COUNT) and then kept current
// from gateway events, so a busy channel doesn't cost a request per message: the messages route shares one rate-limit bucket with
// the open chat's history. Edits and deletes of a cached message drop that channel (refetched once if its card is showing);
// a new READY or signing out clears everything.

import { gateway } from "../api/gateway";
import { request } from "../api/rest";
import { appStore } from "../api/store";
import type { Message, Snowflake } from "../api/types";

/** How many messages a card previews. */
export const PREVIEW_COUNT = 3;

/** Newest first, at most PREVIEW_COUNT. */
const previews = new Map<Snowflake, Message[]>();
const loading = new Set<Snowflake>();
const listeners = new Set<() => void>();
let bound = false;

function changed(): void {
  listeners.forEach(l => l());
}

export function previewOf(channelId: Snowflake): Message[] | undefined {
  return previews.get(channelId);
}

export function subscribePreviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Fetch a channel's preview unless it is cached or already on the way. A failure caches an empty page until the next drop. */
export function loadPreview(channelId: Snowflake): void {
  bindPreviews();
  if (previews.has(channelId) || loading.has(channelId)) return;
  loading.add(channelId);
  request<Message[]>("GET", `/channels/${channelId}/messages?limit=${PREVIEW_COUNT}`)
    .then(
      page => previews.set(channelId, page.slice(0, PREVIEW_COUNT)),
      () => previews.set(channelId, []),
    )
    .finally(() => {
      loading.delete(channelId);
      changed();
    });
}

/** A new message goes on top of a cached channel; uncached channels are fetched when a card asks. */
export function previewCreate(message: Message): void {
  const page = previews.get(message.channel_id);
  if (!page || page.some(m => m.id === message.id)) return;
  previews.set(message.channel_id, [message, ...page].slice(0, PREVIEW_COUNT));
  changed();
}

/** An edit or delete of a message the channel's preview holds: drop the channel so it is fetched fresh. */
export function previewDrop(channelId: Snowflake, messageIds: readonly Snowflake[]): void {
  const page = previews.get(channelId);
  if (!page || !page.some(m => messageIds.includes(m.id))) return;
  previews.delete(channelId);
  changed();
}

export function clearPreviews(): void {
  if (previews.size === 0) return;
  previews.clear();
  changed();
}

function bindPreviews(): void {
  if (bound) return;
  bound = true;
  gateway.on("MESSAGE_CREATE", previewCreate);
  gateway.on("MESSAGE_UPDATE", m => previewDrop(m.channel_id, [m.id]));
  gateway.on("MESSAGE_DELETE", d => previewDrop(d.channel_id, [d.id]));
  gateway.on("MESSAGE_DELETE_BULK", d => previewDrop(d.channel_id, d.ids));
  // A new session (reconnect, other account) may have missed events.
  gateway.on("READY", clearPreviews);
  appStore.subscribe((s, prev) => {
    if (prev.token && !s.token) clearPreviews();
  });
}
