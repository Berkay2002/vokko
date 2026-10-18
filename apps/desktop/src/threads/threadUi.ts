// UI state of the thread feature: which thread is open in the side panel and which thread dialogs are showing.
// Plain zustand store, no React imports: chat/ and shell/ call these functions from their menus.

import { create } from "zustand";
import { searchThreads } from "../api/rest";
import { appStore, useStore } from "../api/store";
import { useNavDrawer } from "../shell/navDrawer";
import { go, guildPath } from "../shell/nav";
import type { Channel, Message, Snowflake } from "../api/types";

interface ThreadUiState {
  /** Thread shown in the side panel. */
  openId: Snowflake | null;
  /** Create-thread dialog: from a message, or free-standing in a channel. */
  create: { channelId: Snowflake; message: Message | null } | null;
  /** Announcement channel whose Follow dialog is open. */
  follow: Snowflake | null;
  /** Bumped to ask the channel header to open its threads popout. */
  listRequest: number;
}

export const useThreadUi = create<ThreadUiState>()(() => ({ openId: null, create: null, follow: null, listRequest: 0 }));

/** Show a thread in the side panel (remembering it in the store so archived threads render too). */
export function openThread(thread: Channel): void {
  appStore.getState().upsertThread(thread);
  useThreadUi.setState({ openId: thread.id });
}

/** Open a thread beside its parent channel, also from elsewhere in the app (a thread's id is no route: the channel is its parent). */
export function goToThread(thread: Channel): void {
  if (thread.guild_id && thread.parent_id) go(guildPath(thread.guild_id, thread.parent_id));
  openThread(thread);
  // Phone: the channel list page would stay over the panel when the parent is already the open channel.
  useNavDrawer.getState().setOpen(false);
}

export function closeThread(): void {
  useThreadUi.setState({ openId: null });
}

/**
 * Open a thread we only know the id of (a "started a thread" notice, an archived thread). There is no GET for a single channel, so an
 * unknown thread is looked up through the parent's thread search by name.
 */
export async function openThreadById(id: Snowflake, parentId: Snowflake | undefined, nameHint: string | undefined): Promise<void> {
  const known = appStore.getState().threads[id];
  if (known) {
    openThread(known);
    return;
  }
  if (!parentId) return;
  try {
    const found = await searchThreads(parentId, { name: nameHint, limit: 25 });
    const match = found.threads.find(t => t.id === id);
    if (match) openThread(match);
  } catch {
    /* the thread is gone or not visible */
  }
}

export const startThreadFlow = (channelId: Snowflake, message: Message | null): void => useThreadUi.setState({ create: { channelId, message } });
export const openFollowDialog = (channelId: Snowflake): void => useThreadUi.setState({ follow: channelId });
export const openThreadList = (): void => useThreadUi.setState(s => ({ listRequest: s.listRequest + 1 }));

/** The thread open in the panel when it belongs to `parentId`. */
export function useOpenThread(parentId: Snowflake): Channel | undefined {
  const openId = useThreadUi(s => s.openId);
  return useStore(s => {
    const thread = openId ? s.threads[openId] : undefined;
    return thread && thread.parent_id === parentId ? thread : undefined;
  });
}
