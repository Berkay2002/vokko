import { describe, expect, it } from 'vitest';
import { timeoutText } from './TimeoutNote';

const NOW = Date.parse('2026-10-18T12:00:00Z');

describe('timeoutText', () => {
  it('counts minutes under an hour', () => {
    expect(timeoutText(NOW + 5 * 60_000, NOW)).toBe('You have been timed out for 5 more minutes.');
    expect(timeoutText(NOW + 4 * 60_000 + 1, NOW)).toBe('You have been timed out for 5 more minutes.');
    expect(timeoutText(NOW + 60_000, NOW)).toBe('You have been timed out for 1 more minute.');
    expect(timeoutText(NOW + 59 * 60_000, NOW)).toBe('You have been timed out for 59 more minutes.');
    expect(timeoutText(NOW + 30_000, NOW)).toBe('You have been timed out for less than a minute.');
  });

  it('names the end from an hour on, with the date when it is not today', () => {
    expect(timeoutText(new Date(NOW + 2 * 3_600_000).toISOString(), NOW)).toMatch(/^You have been timed out until \d{1,2}[:.]\d{2}/);
    expect(timeoutText(NOW + 3 * 86_400_000, NOW)).toMatch(/^You have been timed out until \w{3},? /);
  });
});
