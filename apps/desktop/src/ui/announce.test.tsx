import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { Announcer, announce, currentAnnouncement } from './announce';

it('renders an empty polite status region before any announcement', () => {
  expect(currentAnnouncement()).toBeNull();
  const html = renderToStaticMarkup(<Announcer />);
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-live="polite"');
  expect(html).not.toContain('<span');
});

it('renders the text, and the same text again gets a new key so it is re-announced', () => {
  announce('Moved Alpha up.');
  const first = currentAnnouncement();
  expect(renderToStaticMarkup(<Announcer />)).toContain('<span>Moved Alpha up.</span>');
  announce('Moved Alpha up.');
  const second = currentAnnouncement();
  expect(second?.text).toBe(first?.text);
  expect(second?.id).not.toBe(first?.id);
});

it('clears the message 5 s after the last announcement, and an older timer does not wipe a newer one', () => {
  vi.useFakeTimers();
  announce('one');
  vi.advanceTimersByTime(3000);
  announce('two');
  vi.advanceTimersByTime(3000);
  expect(currentAnnouncement()?.text).toBe('two');
  vi.advanceTimersByTime(2000);
  expect(currentAnnouncement()).toBeNull();
  expect(renderToStaticMarkup(<Announcer />)).not.toContain('<span');
  vi.useRealTimers();
});
