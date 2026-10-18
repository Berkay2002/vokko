import { describe, expect, it } from 'vitest';
import { mediaTargetFrom } from './mediaTarget';

const COVER = '.spoiler, .md-spoiler[role="button"]';

// The node test environment has no DOM: `mediaTargetFrom` only walks up with `closest`, so a stub that answers per selector is enough.
const stub = (hits: Record<string, object>): Element => ({ closest: (selector: string) => hits[selector] ?? null }) as unknown as Element;
const image = { dataset: { src: 'https://x/a.png' } };
const link = { href: 'https://example.org/secret' };

describe('mediaTargetFrom', () => {
  it('finds a revealed picture, video, audio file and web link', () => {
    expect(mediaTargetFrom(stub({ '.chat-image': image }))).toEqual({ kind: 'image', url: 'https://x/a.png' });
    expect(mediaTargetFrom(stub({ 'video.chat-video': { src: 'https://x/a.mp4' } }))).toEqual({ kind: 'video', url: 'https://x/a.mp4' });
    expect(mediaTargetFrom(stub({ 'audio.chat-audio': { src: 'https://x/a.mp3' } }))).toEqual({ kind: 'audio', url: 'https://x/a.mp3' });
    expect(mediaTargetFrom(stub({ 'a[href]': link }))).toMatchObject({ kind: 'link', url: 'https://example.org/secret' });
  });

  it('hands out nothing from under a spoiler cover', () => {
    const cover = { x: 1 };
    expect(mediaTargetFrom(stub({ [COVER]: cover, '.chat-image': image }))).toBeNull(); // a covered picture
    expect(mediaTargetFrom(stub({ [COVER]: cover, 'video.chat-video': { src: 'https://x/a.mp4' } }))).toBeNull(); // a covered video
    expect(mediaTargetFrom(stub({ [COVER]: cover, 'a[href]': link }))).toBeNull(); // a link inside ||spoiler text||
  });

  it('is null for plain text and for links that are not web links', () => {
    expect(mediaTargetFrom(stub({}))).toBeNull();
    expect(mediaTargetFrom(null)).toBeNull();
    expect(mediaTargetFrom(stub({ 'a[href]': { href: 'mailto:a@b.c' } }))).toBeNull();
    expect(mediaTargetFrom(stub({ '.chat-image': { dataset: {} } }))).toBeNull();
  });
});
