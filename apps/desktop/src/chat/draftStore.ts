// Composer drafts and upload tray, kept per channel outside React so they survive channel switches.
import { useSyncExternalStore } from 'react';
import type { Attachment, Snowflake } from '../api/types';
import { uploadAttachment } from './shell';
import type { MentionToken } from './mentionText';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

export interface Upload {
  localId: string;
  file: File;
  previewUrl: string | null;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  attachment?: Attachment;
  error?: string;
  abort: AbortController;
}

export interface Draft {
  text: string;
  tokens: MentionToken[];
  uploads: Upload[];
}

const EMPTY: Draft = { text: '', tokens: [], uploads: [] };
const drafts = new Map<Snowflake, Draft>();
const listeners = new Map<Snowflake, Set<() => void>>();
let seq = 0;

function emit(channelId: Snowflake): void { listeners.get(channelId)?.forEach(l => l()); }
function patch(channelId: Snowflake, fn: (d: Draft) => Draft): void {
  const next = fn(drafts.get(channelId) ?? EMPTY);
  if (next.text === '' && next.uploads.length === 0) drafts.delete(channelId); else drafts.set(channelId, next);
  emit(channelId);
}

export function useDraft(channelId: Snowflake): Draft {
  return useSyncExternalStore(
    cb => {
      let set = listeners.get(channelId);
      if (!set) { set = new Set(); listeners.set(channelId, set); }
      const target = set;
      target.add(cb);
      return () => { target.delete(cb); };
    },
    () => drafts.get(channelId) ?? EMPTY,
  );
}

export function getDraft(channelId: Snowflake): Draft { return drafts.get(channelId) ?? EMPTY; }

export function setDraftText(channelId: Snowflake, text: string, tokens?: MentionToken[]): void {
  patch(channelId, d => ({ ...d, text, tokens: tokens ?? d.tokens }));
}

export function addDraftToken(channelId: Snowflake, token: MentionToken): void {
  patch(channelId, d => (d.tokens.some(t => t.display === token.display) ? d : { ...d, tokens: [...d.tokens, token] }));
}

function setUpload(channelId: Snowflake, localId: string, fn: (u: Upload) => Upload): void {
  patch(channelId, d => ({ ...d, uploads: d.uploads.map(u => (u.localId === localId ? fn(u) : u)) }));
}

export function addFiles(channelId: Snowflake, files: File[]): void {
  const room = MAX_ATTACHMENTS - getDraft(channelId).uploads.length;
  for (const file of files.slice(0, Math.max(0, room))) {
    const localId = `u${++seq}`;
    const tooBig = file.size > MAX_UPLOAD_BYTES;
    const abort = new AbortController();
    const upload: Upload = {
      localId, file, abort, previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null, progress: 0,
      status: tooBig ? 'error' : 'uploading', error: tooBig ? 'File is larger than 25 MB.' : undefined,
    };
    patch(channelId, d => ({ ...d, uploads: [...d.uploads, upload] }));
    if (tooBig) continue;
    uploadAttachment(channelId, file, p => setUpload(channelId, localId, u => ({ ...u, progress: p })), abort.signal)
      .then(attachment => setUpload(channelId, localId, u => ({ ...u, status: 'done', progress: 1, attachment })))
      .catch(e => {
        if (abort.signal.aborted) return;
        setUpload(channelId, localId, u => ({ ...u, status: 'error', error: e instanceof Error ? e.message : 'Upload failed' }));
      });
  }
}

export function removeUpload(channelId: Snowflake, localId: string): void {
  const u = getDraft(channelId).uploads.find(x => x.localId === localId);
  u?.abort.abort();
  if (u?.previewUrl) URL.revokeObjectURL(u.previewUrl);
  patch(channelId, d => ({ ...d, uploads: d.uploads.filter(x => x.localId !== localId) }));
}

/** Clears text and uploads after a send; preview URLs are kept alive by the pending message only through the server URL, so revoke them. */
export function clearDraft(channelId: Snowflake): void {
  for (const u of getDraft(channelId).uploads) if (u.previewUrl) URL.revokeObjectURL(u.previewUrl);
  drafts.delete(channelId);
  emit(channelId);
}
