import type { Message } from '../api/types';
import { appStore, dmPath, go, guildPath, messageStore } from './shell';

const READY_POLL_MS = 40;
const READY_TIMEOUT_MS = 5000;

async function waitUntilReady(channelId: string): Promise<void> {
  const until = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < until) {
    const status = messageStore.getState(channelId).status;
    if (status === 'ready' || status === 'error') return;
    await new Promise(resolve => setTimeout(resolve, READY_POLL_MS));
  }
}

/** Opens the hit's channel when it is not the current one, then scrolls to the message with the same flash replies use. */
export async function jumpToHit(hit: Message, currentChannelId: string): Promise<void> {
  const channelId = hit.channel_id;
  if (channelId !== currentChannelId) {
    const guildId = hit.guild_id ?? appStore.getState().channels[channelId]?.guild_id ?? null;
    go(guildId ? guildPath(guildId, channelId) : dmPath(channelId));
    await waitUntilReady(channelId);
  }
  await messageStore.jumpToMessage(channelId, hit.id);
}
