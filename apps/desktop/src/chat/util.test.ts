import { describe, expect, it } from 'vitest';
import { formatFullDate, formatMessageTimestamp, formatTime } from './util';

// Explicit locales: the output of Intl depends on the machine's default, the tests must not.
describe('formatMessageTimestamp', () => {
  const now = new Date(2026, 9, 11, 15, 0);
  const today = new Date(2026, 9, 11, 9, 5);
  const yesterday = new Date(2026, 9, 10, 21, 24);
  const older = new Date(2026, 9, 9, 21, 24);

  it('Swedish: Idag/Igår kl., then 2026-10-09 21:24', () => {
    expect(formatMessageTimestamp(today, now, 'sv-SE')).toBe('Idag kl. 09:05');
    expect(formatMessageTimestamp(yesterday, now, 'sv-SE')).toBe('Igår kl. 21:24');
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
});
