import { describe, expect, it } from 'vitest';
import type { Attachment } from '../api/types';
import { decodeText, firstLines, isTextPreviewable, languageOf, looksBinary, readPrefix } from './textAttachment';

const att = (filename: string, content_type: string | null, size = 100): Attachment =>
  ({ id: '1', filename, content_type, size, url: 'blob:x', width: null, height: null }) as Attachment;

const stream = (chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({ start(c) { chunks.forEach(x => c.enqueue(x)); c.close(); } });

describe('isTextPreviewable', () => {
  it('takes text/* and known extensions', () => {
    expect(isTextPreviewable(att('notes.txt', 'text/plain'))).toBe(true);
    expect(isTextPreviewable(att('code.rs', null))).toBe(true);
    expect(isTextPreviewable(att('main.TSX', 'application/octet-stream'))).toBe(true);
    expect(isTextPreviewable(att('weird', 'text/x-unknown'))).toBe(true);
    expect(isTextPreviewable(att('photo.png', 'image/png'))).toBe(false);
    expect(isTextPreviewable(att('archive.zip', 'application/zip'))).toBe(false);
    expect(isTextPreviewable(att('rs', null))).toBe(false);
  });
  it('skips files over 1 MB and spoilers', () => {
    expect(isTextPreviewable(att('big.log', 'text/plain', 1024 * 1024))).toBe(true);
    expect(isTextPreviewable(att('big.log', 'text/plain', 1024 * 1024 + 1))).toBe(false);
    expect(isTextPreviewable(att('SPOILER_notes.txt', 'text/plain'))).toBe(false);
  });
  it('maps extensions to the code-block grammars', () => {
    expect(languageOf('code.rs')).toBe('rust');
    expect(languageOf('a.yml')).toBe('yaml');
    expect(languageOf('notes.txt')).toBeNull();
  });
});

describe('binary detection and decoding', () => {
  const enc = new TextEncoder();
  it('flags NUL bytes and control-heavy data, not text', () => {
    expect(looksBinary(enc.encode('fn main() {}\n\tok\r\n'))).toBe(false);
    expect(looksBinary(new Uint8Array([0x50, 0x4b, 0x03, 0x00]))).toBe(true);
    expect(looksBinary(new Uint8Array(50).fill(1))).toBe(true);
    expect(looksBinary(new Uint8Array())).toBe(false);
  });
  it('replaces invalid UTF-8 and drops a sequence cut by truncation', () => {
    expect(decodeText(new Uint8Array([0x61, 0xff, 0x62]), false)).toBe('a�b');
    const euro = enc.encode('a€'); // € is 3 bytes
    expect(decodeText(euro.subarray(0, 3), true)).toBe('a');
  });
});

describe('readPrefix', () => {
  it('stops after the limit and reports truncation', async () => {
    const r = await readPrefix(stream([new Uint8Array(40).fill(97), new Uint8Array(40).fill(98), new Uint8Array(40).fill(99)]), 64);
    expect(r.truncated).toBe(true);
    expect(r.bytes.length).toBe(64);
  });
  it('returns small bodies whole', async () => {
    const r = await readPrefix(stream([new Uint8Array([1, 2]), new Uint8Array([3])]), 64);
    expect(r).toEqual({ bytes: new Uint8Array([1, 2, 3]), truncated: false });
  });
});

describe('firstLines', () => {
  it('cuts to n lines, ignores a trailing newline, handles CRLF', () => {
    expect(firstLines('a\r\nb\r\nc\n', 2)).toEqual({ shown: 'a\nb', total: 3 });
    expect(firstLines('one', 6)).toEqual({ shown: 'one', total: 1 });
  });
});
