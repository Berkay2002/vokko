import { describe, expect, it } from 'vitest';
import { embedColor, findInviteCodes, isVideoUrl, safeHttpUrl } from './embedUtil';

describe('findInviteCodes', () => {
  const hosts = ['127.0.0.1:1422'];
  it('finds vokko.gg/{code} and the app host /invite/{code}', () => {
    expect(findInviteCodes('join https://vokko.gg/abc123 now')).toEqual(['abc123']);
    expect(findInviteCodes('vokko.gg/abc123')).toEqual(['abc123']);
    expect(findInviteCodes('http://127.0.0.1:1422/invite/xyz789', hosts)).toEqual(['xyz789']);
    expect(findInviteCodes('http://127.0.0.1:1422/invite/xyz789')).toEqual([]);
  });
  it('leaves other services and other hosts alone', () => {
    expect(findInviteCodes('https://discord.gg/MXuWj96Fr discord.com/invite/efgh', hosts)).toEqual([]);
    expect(findInviteCodes('https://vokko.example/invite/abc123 https://evilvokko.gg/abc123', hosts)).toEqual([]);
  });
  it('ignores code, suppressed links and unrelated paths', () => {
    expect(findInviteCodes('`https://vokko.gg/abc123`')).toEqual([]);
    expect(findInviteCodes('```\nhttps://vokko.gg/abc123\n```')).toEqual([]);
    expect(findInviteCodes('<https://vokko.gg/abc123>')).toEqual([]);
    expect(findInviteCodes('https://127.0.0.1:1422/invited/abc123 and http://127.0.0.1:1422/invite', hosts)).toEqual([]);
  });
  it('de-duplicates and caps at three', () => {
    expect(findInviteCodes('vokko.gg/aa vokko.gg/aa vokko.gg/bb vokko.gg/cc vokko.gg/dd')).toEqual(['aa', 'bb', 'cc']);
  });
});

describe('embed helpers', () => {
  it('only allows http(s) URLs', () => {
    expect(safeHttpUrl('https://example.org/a?b=1')).toBe('https://example.org/a?b=1');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,hi')).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });
  it('converts colour ints', () => {
    expect(embedColor(0x5865f2)).toBe('#5865f2');
    expect(embedColor(255)).toBe('#0000ff');
    expect(embedColor(undefined)).toBeNull();
  });
  it('detects direct video files', () => {
    expect(isVideoUrl('https://a.test/x.mp4?y=1')).toBe(true);
    expect(isVideoUrl('https://www.youtube.com/embed/abc')).toBe(false);
  });
});
