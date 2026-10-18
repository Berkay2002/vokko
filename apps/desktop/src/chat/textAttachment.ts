// Text and code attachment previews: which files get one, and loading their first bytes (or the whole file, up to 1 MB).
import type { Attachment } from '../api/types';
import { resolveLanguage } from './markdown/languages';
import { isSpoilerName } from './util';

export const PREVIEW_MAX_FILE = 1024 * 1024;
export const PREVIEW_PREFIX_BYTES = 64 * 1024;
export const COLLAPSED_LINES = 6;
export const EXPANDED_LINES = 100;

const TEXT_EXT = new Set([
  'txt', 'text', 'md', 'markdown', 'log', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'csv', 'tsv',
  'rs', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'java', 'kt', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'cs', 'sh', 'bash', 'zsh',
  'ps1', 'bat', 'sql', 'html', 'htm', 'css', 'scss', 'xml', 'svg', 'diff', 'patch', 'lua', 'rb', 'php', 'swift', 'gradle', 'properties',
]);

export const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
};

/** `text/*` or a known text/code extension, at most 1 MB, not a spoiler. */
export function isTextPreviewable(a: Attachment): boolean {
  if (a.size > PREVIEW_MAX_FILE || isSpoilerName(a.filename)) return false;
  return !!a.content_type?.startsWith('text/') || TEXT_EXT.has(extensionOf(a.filename));
}

/** highlight.js grammar for the file, or null for plain text. */
export const languageOf = (filename: string): string | null => resolveLanguage(extensionOf(filename));

/** A NUL byte, or more than 10% control characters other than tab/newline/CR/form feed, in the first 8 KB. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    if (b === 0) return true;
    if (b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 12) control++;
  }
  return n > 0 && control / n > 0.1;
}

/** UTF-8 with replacement characters; a multi-byte sequence cut off by truncation is dropped instead of shown as U+FFFD. */
export const decodeText = (bytes: Uint8Array, truncated: boolean): string => new TextDecoder('utf-8').decode(bytes, { stream: truncated });

export interface LoadedText {
  text: string;
  /** The file is longer than what was read. */
  truncated: boolean;
}

/** Read at most `limit` bytes of the response body, then cancel the rest (the attachments host has no Range support). */
export async function readPrefix(body: ReadableStream<Uint8Array>, limit: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > limit) {
      truncated = true;
      void reader.cancel().catch(() => {});
      break;
    }
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return { bytes: truncated ? all.subarray(0, limit) : all, truncated };
}

// ponytail: per-session cache without eviction; previews are capped at 64 KB each and whole files at 1 MB.
const cache = new Map<string, Promise<LoadedText | null>>();

/** The first `limit` bytes as text, or null when the fetch fails or the file looks binary. Cached per URL and limit. */
export function loadText(url: string, limit: number): Promise<LoadedText | null> {
  const key = `${limit}:${url}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = fetch(url).then(async res => {
      if (!res.ok || !res.body) return null;
      const { bytes, truncated } = await readPrefix(res.body, limit);
      return looksBinary(bytes) ? null : { text: decodeText(bytes, truncated), truncated };
    }).catch(() => {
      cache.delete(key); // a network failure is retried next time; a binary file or an error status stays cached
      return null;
    });
    cache.set(key, hit);
  }
  return hit;
}

/** The first `count` lines. A trailing newline doesn't count as an extra empty line. */
export function firstLines(text: string, count: number): { shown: string; total: number } {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  return { shown: lines.slice(0, count).join('\n'), total: lines.length };
}
