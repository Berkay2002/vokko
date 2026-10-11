import { useState, type FormEvent } from 'react';
import type { Message } from '../api/types';
import { REMINDER_PRESETS, parseCustomReminder, presetReminderTime, toDatetimeLocal } from './helpers';
import { reminderOf } from './lists';
import { createReminder, dismissReminder, useMedia } from './store';

/** A quarter of an hour past the next full hour: a sensible starting point for the custom picker. */
function suggestion(now: Date): string {
  const d = new Date(now.getTime() + 3600 * 1000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  return toDatetimeLocal(d);
}

/** Body of the "Create Reminder" submenu of the message menu: presets, a custom date and time, and removing an existing reminder. */
export function ReminderMenu({ message, close }: { message: Message; close(): void }) {
  const existing = useMedia(s => reminderOf(s.reminders, message.id));
  const [custom, setCustom] = useState(false);
  const [value, setValue] = useState(() => suggestion(new Date()));
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = parseCustomReminder(value);
    if (!parsed.ok) { setError(parsed.error); return; }
    close();
    void createReminder(message, parsed.at);
  }

  return <div className="chat-menu-list media-reminder-menu">
    {REMINDER_PRESETS.map(p => <button key={p.id} type="button" role="menuitem" onClick={() => { close(); void createReminder(message, presetReminderTime(p.id)); }}>{p.label}</button>)}
    <button type="button" role="menuitem" aria-expanded={custom} onClick={() => setCustom(v => !v)}>Custom…</button>
    {custom && <form className="media-reminder-custom" onSubmit={submit} onKeyDown={e => { if (e.key !== 'Escape') e.stopPropagation(); }}>
      <input type="datetime-local" aria-label="Remind me at" value={value} onChange={e => { setValue(e.target.value); setError(null); }} />
      {error && <div className="media-reminder-error" role="alert">{error}</div>}
      <button type="submit" className="btn btn-sm">Set reminder</button>
    </form>}
    {existing && <button type="button" role="menuitem" className="media-reminder-remove" onClick={() => { close(); void dismissReminder(existing.id); }}>Remove reminder</button>}
  </div>;
}
