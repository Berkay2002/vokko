import { useEffect, useState } from 'react';
import { formatDateTime, formatTime } from './util';

/** "You have been timed out for 5 more minutes" under an hour, else "until 4:30 PM" (with the date when it ends on another day). */
export function timeoutText(until: string | number, now = Date.now()): string {
  const end = typeof until === 'number' ? until : Date.parse(until);
  const left = end - now;
  if (left < 60_000) return 'You have been timed out for less than a minute.';
  if (left < 3_600_000) {
    const minutes = Math.ceil(left / 60_000);
    return `You have been timed out for ${minutes} more ${minutes === 1 ? 'minute' : 'minutes'}.`;
  }
  const d = new Date(end);
  return `You have been timed out until ${d.toDateString() === new Date(now).toDateString() ? formatTime(d) : formatDateTime(d)}.`;
}

/** The locked composer's text for a member under timeout; it recounts every 30 s while the minutes are shown. */
export function TimeoutNote({ until }: { until: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return <span>{timeoutText(until, now)}</span>;
}
