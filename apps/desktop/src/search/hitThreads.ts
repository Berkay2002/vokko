import type { MessageSearchResponse } from '../api/types';
import { appStore } from './shell';

/** Threads and forum posts are not in the store until opened: the hits' own come with the response, so the panel can name them and Jump can open them.
 *  A thread the store already has is newer than the snapshot (gateway keeps its last_message_id and counts current): only the viewer's membership is merged. */
export function rememberHitThreads(result: Pick<MessageSearchResponse, 'threads' | 'members'>): void {
  const { threads, upsertThread } = appStore.getState();
  for (const thread of result.threads ?? []) {
    const member = result.members?.find(m => m.id === thread.id) ?? thread.member;
    const known = threads[thread.id];
    if (!known) upsertThread({ ...thread, member });
    else if (member) upsertThread({ ...known, member });
  }
}
