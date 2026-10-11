import { Bell, X } from 'lucide-react';
import { ForwardModal } from './ForwardModal';
import { messageSnippet } from './helpers';
import { useWhere } from './InboxLists';
import { jumpToMessage } from './jump';
import { dismissReminder, hideNotice, useMedia } from './store';
import type { Reminder } from '../api/types';

function Notice({ reminder }: { reminder: Reminder }) {
  const where = useWhere(reminder.message ?? { channel_id: reminder.channel_id, guild_id: reminder.guild_id });
  const m = reminder.message;
  return <div className="media-notice" role="status" data-testid="reminder-notice">
    <span className="media-notice-icon"><Bell size={20} aria-hidden="true" /></span>
    <div className="media-notice-body">
      <div className="media-notice-title">Reminder</div>
      <div className="media-notice-text">{m ? `${m.author.global_name || m.author.username}: ${messageSnippet(m, 120)}` : 'The message is no longer available.'}</div>
      <div className="media-notice-where">{where}</div>
      <div className="media-notice-actions">
        {m && <button type="button" className="btn btn-sm" onClick={() => { hideNotice(reminder.id); void jumpToMessage(reminder.channel_id, reminder.message_id, reminder.guild_id); }}>Jump to message</button>}
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => void dismissReminder(reminder.id)}>Dismiss</button>
      </div>
    </div>
    <button type="button" className="media-icon-btn" aria-label="Hide notice" title="Hide (stays in your inbox)" onClick={() => hideNotice(reminder.id)}><X size={16} /></button>
  </div>;
}

/** Reminders that came due while the app was open. They stay until dismissed here or in the inbox. */
export function ReminderNotices() {
  const notices = useMedia(s => s.notices);
  if (notices.length === 0) return null;
  return <div className="media-notices" aria-label="Reminders">{notices.map(r => <Notice key={r.id} reminder={r} />)}</div>;
}

/** Everything of the media area that lives above the chat view: the Forward dialog and the due-reminder notices. Mounted once by the shell. */
export function MediaHost() {
  return <>
    <ForwardModal />
    <ReminderNotices />
  </>;
}
