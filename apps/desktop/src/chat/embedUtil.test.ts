import { describe, expect, it } from 'vitest';
import { embedColor, findInviteCodes, isVideoUrl, safeHttpUrl } from './embedUtil';

describe('findInviteCodes', () => {
  it('finds /invite/{code} on any host and discord.gg links', () => {
    expect(findInviteCodes('join https://vokko.example/invite/abc123 now')).toEqual(['abc123']);
    expect(findInviteCodes('http://127.0.0.1:1422/invite/xyz789')).toEqual(['xyz789']);
    expect(findInviteCodes('https://discord.gg/MXuWj96Fr')).toEqual(['MXuWj96Fr']);
    expect(findInviteCodes('discord.gg/abcd and discord.com/invite/efgh')).toEqual(['abcd', 'efgh']);
  });
  it('ignores code, suppressed links and unrelated paths', () => {
    expect(findInviteCodes('`https://x.test/invite/abc123`')).toEqual([]);
    expect(findInviteCodes('```\nhttps://x.test/invite/abc123\n```')).toEqual([]);
    expect(findInviteCodes('<https://x.test/invite/abc123>')).toEqual([]);
    expect(findInviteCodes('https://x.test/invited/abc123 and https://x.test/blog/invite')).toEqual([]);
  });
  it('de-duplicates and caps at three', () => {
    expect(findInviteCodes('discord.gg/aa discord.gg/aa discord.gg/bb discord.gg/cc discord.gg/dd')).toEqual(['aa', 'bb', 'cc']);
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
