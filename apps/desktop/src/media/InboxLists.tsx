// Content of the Inbox tabs "Bookmarks" (saved messages) and "Reminders". The shell's Inbox popout mounts these.

import { useEffect } from 'react';
import { Bell, Bookmark, X } from 'lucide-react';
import type { Message } from '../api/types';
import { messageSnippet } from './helpers';
import { jumpToMessage } from './jump';
import { sortReminders } from './lists';
import { dmName, useStore } from './shell';
import { dismissReminder, loadBookmarks, loadReminders, removeBookmarkOf, useMedia } from './store';

/** "#general · Sam's server" / "Direct message with alice" for a message, from what the client knows. */
export function useWhere(message: Pick<Message, 'channel_id' | 'guild_id'> | null): string {
  const channel = useStore(s => (message ? s.channels[message.channel_id] : undefined));
  const guildName = useStore(s => (message?.guild_id ? s.guilds[message.guild_id]?.name : undefined));
  if (!message) return '';
  if (!channel) return message.guild_id ? 'A channel you can no longer see' : 'Direct message';
  if (channel.guild_id) return `#${channel.name ?? 'channel'}${guildName ? ` · ${guildName}` : ''}`;
  return `Direct message with ${dmName(channel)}`;
}

const nameOf = (m: Message): string => m.author.global_name || m.author.username;

const whenFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function BookmarkRow({ message, onNavigate, onRemove }: { message: Message; onNavigate(): void; onRemove(): void }) {
  const where = useWhere(message);
  return <div className="inbox-row media-inbox-row" data-testid="saved-message">
    <button type="button" className="inbox-row-main" aria-label={`Jump to bookmarked message by ${nameOf(message)}`} onClick={() => { onNavigate(); void jumpToMessage(message.channel_id, message.id, message.guild_id); }}>
      <span className="inbox-row-icon"><Bookmark size={18} /></span>
      <span className="inbox-row-text">
        <span className="inbox-row-name">{nameOf(message)}</span>
        <span className="media-inbox-snippet">{messageSnippet(message)}</span>
        <span className="inbox-row-sub">{where}</span>
      </span>
    </button>
    <button type="button" className="media-icon-btn" aria-label="Remove bookmark" title="Remove bookmark" onClick={onRemove}><X size={16} /></button>
  </div>;
}

export function SavedMessages({ onNavigate }: { onNavigate(): void }) {
  const bookmarks = useMedia(s => s.bookmarks);
  useEffect(() => { void loadBookmarks(); }, []);
  if (bookmarks === null) return <div className="inbox-empty" role="status"><Bookmark size={40} /><div className="inbox-empty-title">Loading bookmarks…</div></div>;
  if (bookmarks.length === 0) {
    return <div className="inbox-empty">
      <Bookmark size={40} />
      <div className="inbox-empty-title">No bookmarks yet</div>
      <div className="inbox-empty-body">Use Bookmark Message in a message&rsquo;s menu to keep it here.</div>
    </div>;
  }
  return <>{bookmarks.map(b => <BookmarkRow key={`${b.message.channel_id}:${b.message.id}`} message={b.message} onNavigate={onNavigate} onRemove={() => void removeBookmarkOf(b)} />)}</>;
}

export function ReminderList({ onNavigate }: { onNavigate(): void }) {
  const reminders = useMedia(s => s.reminders);
  useEffect(() => { void loadReminders(); }, []);
  if (reminders === null) return <div className="inbox-empty" role="status"><Bell size={40} /><div className="inbox-empty-title">Loading reminders…</div></div>;
  if (reminders.length === 0) {
    return <div className="inbox-empty">
      <Bell size={40} />
      <div className="inbox-empty-title">No reminders</div>
      <div className="inbox-empty-body">Use Create Reminder in a message&rsquo;s menu and it will show up here.</div>
    </div>;
  }
  return <>{sortReminders(reminders).map(r => {
    const due = !!r.delivered_at;
    return <div key={r.id} className={`inbox-row media-inbox-row${due ? ' due' : ''}`} data-testid="reminder">
      <button type="button" className="inbox-row-main" disabled={!r.message} aria-label={r.message ? `Jump to reminded message by ${nameOf(r.message)}` : 'Message no longer available'}
        onClick={() => { if (!r.message) return; onNavigate(); void jumpToMessage(r.channel_id, r.message_id, r.guild_id); }}>
        <span className="inbox-row-icon"><Bell size={18} /></span>
        <span className="inbox-row-text">
          <span className="inbox-row-name">{r.message ? nameOf(r.message) : 'Message no longer available'}</span>
          {r.message && <span className="media-inbox-snippet">{messageSnippet(r.message)}</span>}
          <span className={`inbox-row-sub${due ? ' media-due' : ''}`}>{due ? 'Reminder is due' : `Reminds you ${whenFormat.format(new Date(r.remind_at))}`}</span>
        </span>
      </button>
      <button type="button" className="media-icon-btn" aria-label={due ? 'Dismiss reminder' : 'Cancel reminder'} title={due ? 'Dismiss' : 'Cancel reminder'} onClick={() => void dismissReminder(r.id)}><X size={16} /></button>
    </div>;
  })}</>;
}
