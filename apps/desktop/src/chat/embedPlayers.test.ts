import { describe, expect, it } from 'vitest';
import { playerSrc } from './embedPlayers';

describe('playerSrc', () => {
  it('maps allow-listed player URLs to an iframe src', () => {
    expect(playerSrc('https://www.youtube.com/embed/dQw4w9WgXcQ', true)).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1');
    expect(playerSrc('https://youtube.com/embed/dQw4w9WgXcQ?start=42', true)).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42&autoplay=1');
    expect(playerSrc('https://player.vimeo.com/video/76979871?h=8272103f6e', true)).toBe('https://player.vimeo.com/video/76979871?h=8272103f6e&autoplay=1');
    expect(playerSrc('https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT', true)).toBe('https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT');
  });
  it('gives other hosts, schemes and paths no iframe', () => {
    for (const url of [
      'https://example.org/embed/dQw4w9WgXcQ',
      'https://www.youtube.com.evil.example/embed/dQw4w9WgXcQ',
      'https://evil.example/?u=https://www.youtube.com/embed/x',
      'http://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com:8443/embed/dQw4w9WgXcQ',
      'https://user@www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
      'https://cdn.example/clip.mp4',
      'https://constructor/embed/x',
      'not a url',
    ]) expect(playerSrc(url, true), url).toBeNull();
    expect(playerSrc(null, true)).toBeNull();
  });
  it('gives no iframe when link media display is off', () => {
    expect(playerSrc('https://www.youtube.com/embed/dQw4w9WgXcQ', false)).toBeNull();
  });
});
