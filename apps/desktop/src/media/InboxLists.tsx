// Content of the Inbox tabs "Mentions", "Bookmarks" (saved messages) and "Reminders". The shell's Inbox popout mounts these.

import { useEffect, useState } from 'react';
import { AtSign, Bell, Bookmark, Check, X } from 'lucide-react';
import type { Message } from '../api/types';
import { messageSnippet } from './helpers';
import { jumpToMessage } from './jump';
import { sortReminders } from './lists';
import { Avatar, dmName, request, useStore } from './shell';
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

const MENTIONS_PAGE = 25;

interface MentionFilters { thisServer: boolean; everyone: boolean; roles: boolean }

function mentionsPath(filters: MentionFilters, guildId: string | null, before?: string): string {
  const params = new URLSearchParams({ limit: String(MENTIONS_PAGE), everyone: String(filters.everyone), roles: String(filters.roles) });
  if (filters.thisServer && guildId) params.set('guild_id', guildId);
  if (before) params.set('before', before);
  return `/users/@me/mentions?${params}`;
}

function MentionRow({ message, showWhere, onNavigate, onRemove }: { message: Message; showWhere: boolean; onNavigate(): void; onRemove(): void }) {
  const where = useWhere(message);
  return <>
    {showWhere && <div className="media-mention-where">{where}</div>}
    <div className="inbox-row media-inbox-row" data-testid="mention">
      <button type="button" className="inbox-row-main" aria-label={`Jump to message by ${nameOf(message)}`} onClick={() => { onNavigate(); void jumpToMessage(message.channel_id, message.id, message.guild_id); }}>
        <span className="inbox-row-icon"><Avatar user={message.author} size={32} guildId={message.guild_id} /></span>
        <span className="inbox-row-text">
          <span className="inbox-row-name">{nameOf(message)} <span className="inbox-row-sub">{whenFormat.format(new Date(message.timestamp))}</span></span>
          <span className="media-inbox-snippet">{messageSnippet(message)}</span>
        </span>
      </button>
      <button type="button" className="media-icon-btn" aria-label="Remove mention" title="Remove" onClick={onRemove}><X size={16} /></button>
    </div>
  </>;
}

/** Inbox > Mentions: recent messages that mention you (GET /users/@me/mentions). They stay after the channel is read; X removes one. */
export function MentionList({ onNavigate }: { onNavigate(): void }) {
  // The server being viewed (/channels/{guild}/...), read once per mount: the popout remounts the tab each time it opens.
  const [guildId] = useState(() => /^\/channels\/(\d+)/.exec(window.location.pathname)?.[1] ?? null);
  const [filters, setFilters] = useState<MentionFilters>({ thisServer: false, everyone: true, roles: true });
  const [items, setItems] = useState<Message[] | null>(null);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const scopeGuild = filters.thisServer ? guildId : null;

  useEffect(() => {
    let live = true;
    setItems(null);
    setFailed(false);
    request<Message[]>('GET', mentionsPath(filters, guildId)).then(
      list => { if (live) { setItems(list); setMore(list.length === MENTIONS_PAGE); } },
      () => { if (live) { setItems([]); setFailed(true); } },
    );
    return () => { live = false; };
  }, [scopeGuild, filters.everyone, filters.roles]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = () => {
    const last = items?.at(-1);
    if (!last) return;
    void request<Message[]>('GET', mentionsPath(filters, guildId, last.id)).then(list => {
      setItems(current => [...(current ?? []), ...list]);
      setMore(list.length === MENTIONS_PAGE);
    }, () => setMore(false));
  };
  const remove = (id: string) => {
    setItems(current => current?.filter(m => m.id !== id) ?? null);
    void request('DELETE', `/users/@me/mentions/${id}`).catch(() => undefined);
  };
  const toggle = (key: keyof MentionFilters, label: string) => (
    <button type="button" className="media-mention-filter" aria-pressed={filters[key]} onClick={() => setFilters(f => ({ ...f, [key]: !f[key] }))}>
      {filters[key] && <Check size={14} />}{label}
    </button>
  );

  return <>
    <div className="media-mention-filters" role="group" aria-label="Mention filters">
      {guildId && toggle('thisServer', 'This server only')}
      {toggle('everyone', 'Include @everyone')}
      {toggle('roles', 'Include role mentions')}
    </div>
    {items === null && <div className="inbox-empty" role="status"><AtSign size={40} /><div className="inbox-empty-title">Loading mentions…</div></div>}
    {items?.length === 0 && <div className="inbox-empty">
      <AtSign size={40} />
      <div className="inbox-empty-title">{failed ? 'Couldn’t load mentions' : 'No recent mentions'}</div>
      <div className="inbox-empty-body">{failed ? 'Check your connection and open the tab again.' : 'Messages that mention you will show up here.'}</div>
    </div>}
    {items?.map((m, i) => <MentionRow key={m.id} message={m} showWhere={items[i - 1]?.channel_id !== m.channel_id} onNavigate={onNavigate} onRemove={() => remove(m.id)} />)}
    {more && <button type="button" className="btn btn-secondary btn-sm media-mention-more" onClick={loadMore}>Load more</button>}
  </>;
}
