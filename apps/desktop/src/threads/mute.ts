import { appStore, useStore } from "../api/store";
import type { Channel, ThreadMember, UpdateThreadMemberRequest } from "../api/types";
import { isMutedAt, withThreadMember, type NotifyLocalState } from "../notify/decide";
import { threadMuteItem, threadNotificationItem } from "../shell/menus";
import { useLocalState } from "../shell/localState";
import type { MenuItem } from "../ui";
import { patchThreadMember } from "./memberSettings";

/**
 * Muted like a channel row: the thread's own mute (thread member, a timed one lapses at its end), its forum or channel, or that one's category.
 * `categoryId` is the parent channel's own parent.
 */
export function isThreadMuted(thread: Pick<Channel, "id" | "parent_id">, member: ThreadMember | undefined, categoryId: string | null | undefined, local: NotifyLocalState, now = Date.now()): boolean {
  const overlaid = withThreadMember(local, thread.id, member);
  return [thread.id, thread.parent_id, categoryId].some(id => isMutedAt(overlaid, id, now));
}

/** The viewer's thread member, read from the store (list responses carry stale copies; the bell patches the store). */
export const useThreadMember = (thread: Channel): ThreadMember | undefined => useStore(s => s.threads[thread.id]?.member ?? thread.member);

export function useThreadMuted(thread: Channel): boolean {
  const member = useThreadMember(thread);
  const categoryId = useStore(s => (thread.parent_id ? s.channels[thread.parent_id]?.parent_id : null));
  const mutedUntil = useLocalState(s => s.mutedUntil);
  const notify = useLocalState(s => s.notify);
  return isThreadMuted(thread, member, categoryId, { ...useLocalState.getState(), mutedUntil, notify });
}

/** Mute Thread / Notification Settings, the same items as the panel's bell, for a thread's context menu. */
export function threadBellItems(thread: Channel): MenuItem[] {
  const member = appStore.getState().threads[thread.id]?.member ?? thread.member;
  const apply = (patch: UpdateThreadMemberRequest) => void patchThreadMember(thread.id, patch);
  return [threadMuteItem(member, apply), threadNotificationItem(member, apply)];
}
