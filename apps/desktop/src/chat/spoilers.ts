import { useSyncExternalStore } from 'react';
import type { Attachment } from '../api/types';
import { useChat } from './ChatContext';
import { isSpoilerName } from './util';

// Attachments the viewer has clicked open this session. Shared, so the tile in the chat and the image viewer agree on what is still covered.
const revealed = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

export function revealSpoiler(id: string): void {
  if (revealed.has(id)) return;
  revealed.add(id);
  version++;
  listeners.forEach(listener => listener());
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Whether an attachment is still behind its SPOILER_ cover (Settings > Chat > spoiler content can lift every cover). */
export function useIsCovered(): (attachment: Attachment) => boolean {
  const chat = useChat();
  useSyncExternalStore(subscribe, () => version);
  return a => isSpoilerName(a.filename) && !chat.revealSpoilers && !revealed.has(a.id);
}
