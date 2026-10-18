import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../api/errors';
import { usePrefs } from '../ui/prefs';
import { MAX_UPLOAD_BYTES, maxUploadBytes, setMaxUploadBytes } from '../api/limits';
import { ChannelType, type Channel, type User } from '../api/types';
import { composerPlaceholder, formatFullDate, formatMessageTimestamp, formatTime, uploadErrorMessage } from './util';

describe('upload limit', () => {
  it('is 500 MiB, the Nitro limit and the server default', () => {
    expect(MAX_UPLOAD_BYTES).toBe(500 * 1024 * 1024);
  });

  it('413 / 40005 names the limit instead of the bare server message', () => {
    const e = new ApiRequestError(413, { code: 40005, message: 'Request entity too large' });
    expect(uploadErrorMessage(e, MAX_UPLOAD_BYTES + 1)).toBe('This file is larger than the limit of 500 MiB per file.');
    // a self-host with a lower limit refuses a smaller file
    expect(uploadErrorMessage(e, 30 * 1024 * 1024)).toBe("This file is larger than this server's upload limit (at most 500 MiB per file).");
    const quota = new ApiRequestError(413, { code: 40005, message: 'Too many pending uploads: send a message with them first (500 MiB limit).' });
    expect(uploadErrorMessage(quota, 1024)).toMatch(/size quota/);
    expect(uploadErrorMessage(new Error('boom'))).toBe('boom');
    expect(uploadErrorMessage('x')).toBe('Upload failed');
  });
});

// Explicit locales: the output of Intl depends on the machine's default, the tests must not.
describe('formatMessageTimestamp', () => {
  const now = new Date(2026, 9, 11, 15, 0);
  const today = new Date(2026, 9, 11, 9, 5);
  const yesterday = new Date(2026, 9, 10, 21, 24);
  const older = new Date(2026, 9, 9, 21, 24);

  it('Swedish (as measured in Discord): bare 09:05 today, dated form from yesterday on', () => {
    expect(formatMessageTimestamp(today, now, 'sv-SE')).toBe('09:05');
    expect(formatMessageTimestamp(yesterday, now, 'sv-SE')).toBe('2026-10-10 21:24');
    expect(formatMessageTimestamp(older, now, 'sv-SE')).toBe('2026-10-09 21:24');
  });

  it('English: Today at / Yesterday at, then 10/09/2026 9:24 PM', () => {
    expect(formatMessageTimestamp(today, now, 'en-US')).toMatch(/^Today at 9:05\s?AM$/);
    expect(formatMessageTimestamp(yesterday, now, 'en-US')).toMatch(/^Yesterday at 9:24\s?PM$/);
    expect(formatMessageTimestamp(older, now, 'en-US')).toMatch(/^10\/09\/2026 9:24\s?PM$/);
  });

  it('falls back to the relative word of an unlisted language', () => {
    expect(formatMessageTimestamp(today, now, 'nl-NL')).toMatch(/^Vandaag /);
  });

  it('time-only and full date follow the locale', () => {
    expect(formatTime(older, 'sv-SE')).toBe('21:24');
    expect(formatFullDate(older, 'en-US')).toMatch(/^Friday, October 9, 2026 at 9:24\s?PM$/);
  });

  it('the time format preference forces 12 or 24 hour in the time and the full date', () => {
    try {
      usePrefs.setState({ timeFormat: '24' });
      expect(formatTime(older, 'en-US')).toBe('21:24');
      expect(formatFullDate(older, 'en-US')).toMatch(/21:24/);
      usePrefs.setState({ timeFormat: '12' });
      expect(formatTime(older, 'sv-SE')).toMatch(/^9:24\s?(PM|em)/i);
      expect(formatFullDate(older, 'sv-SE')).toMatch(/9:24/);
    } finally {
      usePrefs.setState({ timeFormat: 'auto' });
    }
  });
});

describe('server-driven upload limit', () => {
  it('READY max_upload_bytes replaces the 500 MiB default, never above it', () => {
    const e = new ApiRequestError(413, { code: 40005, message: 'Request entity too large' });
    setMaxUploadBytes(95 * 1024 * 1024);
    try {
      expect(maxUploadBytes()).toBe(95 * 1024 * 1024);
      expect(uploadErrorMessage(e, 96 * 1024 * 1024)).toBe('This file is larger than the limit of 95 MiB per file.');
      setMaxUploadBytes(4096 * 1024 * 1024);
      expect(maxUploadBytes()).toBe(MAX_UPLOAD_BYTES);
    } finally {
      setMaxUploadBytes(undefined);
    }
    expect(maxUploadBytes()).toBe(MAX_UPLOAD_BYTES);
  });
});

describe('composer placeholder', () => {
  const user = (id: string, name: string) => ({ id, username: name, global_name: null }) as User;
  const channel = (type: ChannelType, name: string | null, recipients: User[] = []) => ({ id: '1', type, name, recipients }) as unknown as Channel;
  const nameOf = (u: User) => u.username;
  const [alice, bob] = [user('2', 'alice'), user('3', 'bob')];

  it('names the other person in a 1:1 DM', () => {
    expect(composerPlaceholder(channel(ChannelType.DM, null, [alice]), nameOf)).toBe('Message @alice');
  });
  it('uses the group name, or the members joined, in a group DM', () => {
    expect(composerPlaceholder(channel(ChannelType.GroupDM, 'Crew', [alice, bob]), nameOf)).toBe('Message Crew');
    expect(composerPlaceholder(channel(ChannelType.GroupDM, null, [alice, bob]), nameOf)).toBe('Message alice, bob');
  });
  it('uses #name in guild text channels and the bare name in voice', () => {
    expect(composerPlaceholder(channel(ChannelType.GuildText, 'general'), nameOf)).toBe('Message #general');
    expect(composerPlaceholder(channel(ChannelType.GuildVoice, 'Lounge'), nameOf)).toBe('Message Lounge');
  });
});
