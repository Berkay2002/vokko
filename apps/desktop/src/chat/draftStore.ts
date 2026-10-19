// Composer drafts and upload tray, kept per channel outside React so they survive channel switches.
import { useCallback, useSyncExternalStore } from 'react';
import type { Attachment, Snowflake } from '../api/types';
import { MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, maxUploadBytes } from '../api/limits';
import { currentUserId, onSessionEnd, onUserChange, uploadAttachment } from './shell';
import { uploadErrorMessage } from './util';
import type { MentionToken } from './mentionText';

export { MAX_ATTACHMENTS, MAX_UPLOAD_BYTES };

export interface Upload {
  localId: string;
  file: File;
  previewUrl: string | null;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  attachment?: Attachment;
  error?: string;
  abort: AbortController;
  /** Settles with the server attachment (rejects on error or abort); a send queued behind this upload waits on it after the draft is cleared. */
  done: Promise<Attachment>;
  /** Set from the tray's "Modify Attachment" dialog; sent as CreateMessageRequest.attachments[] (name may carry the SPOILER_ prefix). */
  filename?: string;
  description?: string;
}

export interface Draft {
  text: string;
  tokens: MentionToken[];
  uploads: Upload[];
}

const EMPTY: Draft = { text: '', tokens: [], uploads: [] };

// Text and tokens (not uploads) survive a reload or restart in localStorage, newest last, one key per account.
export const draftsKey = (userId: string): string => `vokko.drafts.${userId}`;
export const MAX_SAVED_DRAFTS = 50;
export const MAX_SAVED_TEXT = 4000;
const SAVE_DELAY_MS = 500;

const drafts = new Map<Snowflake, Draft>();
let owner: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** The last write to storage threw (quota, blocked): the text then exists only in memory. */
let lastFlushFailed = false;

function loadDrafts(userId: string): void {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(draftsKey(userId)) ?? '[]');
    if (!Array.isArray(saved)) return;
    for (const e of saved as Array<[Snowflake, string, MentionToken[]]>) {
      if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string' && e[1] !== '') {
        drafts.set(e[0], { text: e[1].slice(0, MAX_SAVED_TEXT), tokens: Array.isArray(e[2]) ? e[2] : [], uploads: [] });
      }
    }
  } catch { /* no storage or a corrupt entry: start empty */ }
}

/** Drafts belong to the account that typed them: on sign-out or an account change the previous account's are dropped and its key wiped. */
function switchOwner(next: string | null): void {
  if (next === owner) return;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (owner) try { localStorage.removeItem(draftsKey(owner)); } catch { /* blocked storage */ }
  drafts.clear();
  lastFlushFailed = false;
  owner = next;
  if (next) loadDrafts(next);
  listeners.forEach(set => set.forEach(l => l()));
}

/** Writes the drafts now (also on pagehide and before "Restart to Update", where the debounce would lose the last keystrokes). */
export function flushDrafts(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!owner) return;
  const entries = [...drafts].filter(([, d]) => d.text !== '').slice(-MAX_SAVED_DRAFTS).map(([id, d]) => [id, d.text.slice(0, MAX_SAVED_TEXT), d.tokens]);
  try {
    if (entries.length === 0) localStorage.removeItem(draftsKey(owner)); else localStorage.setItem(draftsKey(owner), JSON.stringify(entries));
    lastFlushFailed = false;
  } catch { lastFlushFailed = true; /* storage full or blocked: the draft stays in memory */ }
}
const saveSoon = (): void => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushDrafts, SAVE_DELAY_MS);
};
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('pagehide', flushDrafts);
  // Tray Quit and Cmd+Q give the page no event: a hidden window (or tab) has at least been saved.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDrafts(); });
}

const listeners = new Map<Snowflake, Set<() => void>>();
let seq = 0;
onUserChange(switchOwner);
// A rejected token on a fresh page load never reveals who was signed in: drop every account's saved drafts.
onSessionEnd(() => {
  switchOwner(null);
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(draftsKey(''))) localStorage.removeItem(k);
    }
  } catch { /* blocked storage */ }
});
switchOwner(currentUserId());

function emit(channelId: Snowflake): void { listeners.get(channelId)?.forEach(l => l()); }
function patch(channelId: Snowflake, fn: (d: Draft) => Draft): void {
  const next = fn(drafts.get(channelId) ?? EMPTY);
  drafts.delete(channelId); // re-inserted last, so Map order is recency
  if (next.text !== '' || next.uploads.length > 0) drafts.set(channelId, next);
  saveSoon();
  emit(channelId);
}

/** Listen to one channel's draft (the listener set is dropped with its last listener). */
export function subscribeDraft(channelId: Snowflake, cb: () => void): () => void {
  let set = listeners.get(channelId);
  if (!set) { set = new Set(); listeners.set(channelId, set); }
  const target = set;
  target.add(cb);
  return () => {
    target.delete(cb);
    if (target.size === 0 && listeners.get(channelId) === target) listeners.delete(channelId);
  };
}

export function useDraft(channelId: Snowflake): Draft {
  // Stable per channel: a new subscribe function every render makes React unsubscribe and resubscribe after each commit.
  const subscribe = useCallback((cb: () => void) => subscribeDraft(channelId, cb), [channelId]);
  const snapshot = useCallback(() => getDraft(channelId), [channelId]);
  return useSyncExternalStore(subscribe, snapshot);
}

export function getDraft(channelId: Snowflake): Draft { return drafts.get(channelId) ?? EMPTY; }

/**
 * True when a reload would lose something: uploads, or typed text the saved copy cannot hold (longer than MAX_SAVED_TEXT, beyond the
 * newest MAX_SAVED_DRAFTS, or a write that failed). Other typed text is restored from storage.
 */
export function hasUnsentDraft(): boolean {
  flushDrafts(); // settles lastFlushFailed against what is typed right now
  const texts = [...drafts.values()].filter(d => d.text !== '');
  return lastFlushFailed || texts.length > MAX_SAVED_DRAFTS || [...drafts.values()].some(d => d.uploads.length > 0 || d.text.length > MAX_SAVED_TEXT);
}

export function setDraftText(channelId: Snowflake, text: string, tokens?: MentionToken[]): void {
  patch(channelId, d => ({ ...d, text, tokens: tokens ?? d.tokens }));
}

export function addDraftToken(channelId: Snowflake, token: MentionToken): void {
  patch(channelId, d => (d.tokens.some(t => t.display === token.display) ? d : { ...d, tokens: [...d.tokens, token] }));
}

/** Appends a mention ("@Name " after a space when the text does not end in one) and its token to a channel's draft; the Mention item of the member menu. */
export function insertDraftMention(channelId: Snowflake, token: MentionToken): void {
  patch(channelId, d => ({
    ...d,
    text: `${d.text}${d.text === '' || /\s$/.test(d.text) ? '' : ' '}${token.display} `,
    tokens: d.tokens.some(t => t.display === token.display) ? d.tokens : [...d.tokens, token],
  }));
}

function setUpload(channelId: Snowflake, localId: string, fn: (u: Upload) => Upload): void {
  patch(channelId, d => ({ ...d, uploads: d.uploads.map(u => (u.localId === localId ? fn(u) : u)) }));
}

/** Files refused before upload; the view shows Discord-style "files are too powerful" / "too many uploads" modals. */
export type UploadNotice = { kind: 'too-large'; names: string[] } | { kind: 'too-many' };
const noticeListeners = new Set<(n: UploadNotice) => void>();
export function onUploadNotice(listener: (n: UploadNotice) => void): () => void {
  noticeListeners.add(listener);
  return () => { noticeListeners.delete(listener); };
}
const notify = (n: UploadNotice): void => noticeListeners.forEach(l => l(n));

export function addFiles(channelId: Snowflake, files: File[]): void {
  const max = maxUploadBytes();
  const tooBig = files.filter(f => f.size > max);
  const fits = files.filter(f => f.size <= max);
  const room = Math.max(0, MAX_ATTACHMENTS - getDraft(channelId).uploads.length);
  if (tooBig.length > 0) notify({ kind: 'too-large', names: tooBig.map(f => f.name) });
  else if (fits.length > room) notify({ kind: 'too-many' });
  for (const file of fits.slice(0, room)) {
    const localId = `u${++seq}`;
    const abort = new AbortController();
    const done = uploadAttachment(channelId, file, p => setUpload(channelId, localId, u => ({ ...u, progress: p })), abort.signal);
    const upload: Upload = {
      localId, file, abort, done, previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null, progress: 0, status: 'uploading',
    };
    patch(channelId, d => ({ ...d, uploads: [...d.uploads, upload] }));
    done
      .then(attachment => setUpload(channelId, localId, u => ({ ...u, status: 'done', progress: 1, attachment })))
      .catch(e => {
        if (abort.signal.aborted) return;
        setUpload(channelId, localId, u => ({ ...u, status: 'error', error: uploadErrorMessage(e, file.size) }));
      });
  }
}

export function updateUpload(channelId: Snowflake, localId: string, details: { filename: string; description: string }): void {
  setUpload(channelId, localId, u => ({ ...u, filename: details.filename, description: details.description }));
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
  flushDrafts(); // a sent message must not come back if the app quits within the debounce
  emit(channelId);
}
