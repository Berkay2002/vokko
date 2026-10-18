import { channelOrThread } from '../api/store';
import type { Snowflake } from '../api/types';
import { goToThread } from '../threads/threadUi';
import { appStore, dmPath, go, guildPath, messageStore } from './shell';

const POLL_MS = 40;
const TIMEOUT_MS = 5000;

async function waitUntilReady(channelId: Snowflake): Promise<void> {
  const until = Date.now() + TIMEOUT_MS;
  while (Date.now() < until) {
    const status = messageStore.getState(channelId).status;
    if (status === 'ready' || status === 'error') return;
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

/** Is the channel one this client knows (joined server, open DM or a thread we hold)? Only then can we show "jump to original". */
export const isKnownChannel = (channelId: Snowflake): boolean => !!channelOrThread(appStore.getState(), channelId);

/** Opens the channel (unless it is the one on screen) and scrolls to the message with the usual flash. A thread opens in the panel beside its parent. */
export async function jumpToMessage(channelId: Snowflake, messageId: Snowflake, guildId?: Snowflake | null): Promise<void> {
  const thread = appStore.getState().threads[channelId];
  if (thread && !appStore.getState().channels[channelId]) {
    if (!goToThread(thread)) return;
    await waitUntilReady(channelId);
    await messageStore.jumpToMessage(channelId, messageId);
    return;
  }
  const route = appStore.getState().route;
  if (route.channelId !== channelId) {
    const guild = guildId ?? appStore.getState().channels[channelId]?.guild_id ?? null;
    go(guild ? guildPath(guild, channelId) : dmPath(channelId));
    await waitUntilReady(channelId);
  }
  await messageStore.jumpToMessage(channelId, messageId);
}
