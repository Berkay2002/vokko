import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Hash, Search, Users, X } from 'lucide-react';
import { MessageReferenceType, type CreateMessageRequest, type Message, type Snowflake } from '../api/types';
import { Avatar } from '../chat/Avatar';
import { formatMessageTimestamp } from '../chat/util';
import { MAX_FORWARD_DESTINATIONS, forwardDestinations, messageSnippet, toggleDestination, type ForwardDestination } from './helpers';
import { Modal, appStore, chatToast, dmName, request, useStore } from './shell';
import { closeForward, useMedia } from './store';

const MAX_COMMENT = 2000;

interface Failure { id: Snowflake; reason: string }

function DestinationIcon({ d }: { d: ForwardDestination }) {
  const channel = useStore(s => s.channels[d.id]);
  if (d.kind === 'channel') return <Hash size={20} aria-hidden="true" />;
  if (d.kind === 'dm' && channel?.recipients?.[0]) return <Avatar user={channel.recipients[0]} size={24} />;
  return <Users size={20} aria-hidden="true" />;
}

function Preview({ message }: { message: Message }) {
  const name = message.author.global_name || message.author.username;
  return <div className="media-forward-preview" aria-label="Message preview">
    <Avatar user={message.author} size={32} />
    <div className="media-forward-preview-body">
      <div className="media-forward-preview-head"><b>{name}</b> <time dateTime={message.timestamp}>{formatMessageTimestamp(new Date(message.timestamp))}</time></div>
      <div className="media-forward-preview-text">{messageSnippet(message, 200)}</div>
    </div>
  </div>;
}

/** Sends the forward (and the optional comment as a separate message) to one destination. */
async function forwardTo(message: Message, destination: Snowflake, comment: string): Promise<void> {
  const forward: CreateMessageRequest = { message_reference: { type: MessageReferenceType.Forward, message_id: message.id, channel_id: message.channel_id } };
  await request<Message>('POST', `/channels/${destination}/messages`, forward);
  if (comment) await request<Message>('POST', `/channels/${destination}/messages`, { content: comment } satisfies CreateMessageRequest);
}

function ForwardBody({ message }: { message: Message }) {
  const me = useStore(s => s.me);
  const channels = useStore(s => s.channels);
  const privateChannels = useStore(s => s.privateChannels);
  const guildOrder = useStore(s => s.guildOrder);
  const guilds = useStore(s => s.guilds);
  const members = useStore(s => s.members);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Snowflake[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<Failure[]>([]);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => { search.current?.focus(); }, []);

  const input = { channels, privateChannels, guildOrder, guilds, members, dmLabel: dmName };
  const all = useMemo(() => (me ? forwardDestinations({ ...input, me, query: '' }) : []), [me, channels, privateChannels, guildOrder, guilds, members]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = useMemo(() => (me ? forwardDestinations({ ...input, me, query }) : []), [me, query, channels, privateChannels, guildOrder, guilds, members]); // eslint-disable-line react-hooks/exhaustive-deps
  const full = selected.length >= MAX_FORWARD_DESTINATIONS;
  const tooLong = comment.length > MAX_COMMENT;

  async function send() {
    if (busy || selected.length === 0 || tooLong) return;
    setBusy(true);
    setFailures([]);
    const failed: Failure[] = [];
    const text = comment.trim();
    for (const id of selected) {
      try { await forwardTo(message, id, text); } catch (e) { failed.push({ id, reason: e instanceof Error ? e.message : 'Could not forward.' }); }
    }
    setBusy(false);
    const sent = selected.filter(id => !failed.some(f => f.id === id));
    if (failed.length === 0) {
      closeForward();
      const first = channels[sent[0] ?? ''];
      const label = first ? (first.guild_id ? `#${first.name ?? 'channel'}` : dmName(first)) : 'the conversation';
      chatToast(sent.length === 1 ? `Message forwarded to ${label}.` : `Message forwarded to ${sent.length} conversations.`);
      return;
    }
    setSelected(failed.map(f => f.id));
    setFailures(failed);
    if (sent.length > 0) chatToast(`Forwarded to ${sent.length}, ${failed.length} failed.`);
  }

  const nameOf = (id: Snowflake): string => { const c = appStore.getState().channels[id]; return c ? (c.guild_id ? `#${c.name ?? 'channel'}` : dmName(c)) : 'conversation'; };

  return <div className="media-forward-modal">
    <div className="media-forward-search">
      <Search size={18} aria-hidden="true" />
      <input ref={search} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search for channels or conversations" aria-label="Search channels and conversations" spellCheck={false} />
      {query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><X size={16} /></button>}
    </div>
    <ul className="media-forward-list" aria-label="Destinations" aria-multiselectable="true" role="listbox">
      {visible.map(d => {
        const on = selected.includes(d.id);
        const disabled = !on && full;
        return <li key={d.id} role="option" aria-selected={on} aria-disabled={disabled || undefined}>
          <button type="button" className={`media-forward-row${on ? ' selected' : ''}`} disabled={disabled} onClick={() => setSelected(s => toggleDestination(s, d.id))}>
            <span className="media-forward-row-icon"><DestinationIcon d={d} /></span>
            <span className="media-forward-row-name">{d.name}</span>
            {d.sub && <span className="media-forward-row-sub">{d.sub}</span>}
            <span className={`media-forward-check${on ? ' on' : ''}`} aria-hidden="true">{on && <Check size={14} />}</span>
          </button>
        </li>;
      })}
      {visible.length === 0 && <li className="media-forward-none" role="presentation">{all.length === 0 ? 'There is nowhere you can post yet.' : `No channels or conversations match “${query.trim()}”.`}</li>}
    </ul>
    <div className="media-forward-counter" aria-live="polite">{selected.length}/{MAX_FORWARD_DESTINATIONS} selected{full ? ' · that is the most you can pick' : ''}</div>
    <Preview message={message} />
    <textarea className="media-forward-comment" value={comment} onChange={e => setComment(e.target.value)} rows={2} placeholder="Add an optional comment" aria-label="Optional comment" maxLength={MAX_COMMENT + 200} />
    {failures.length > 0 && <div className="media-forward-errors" role="alert">
      {failures.map(f => <div key={f.id}>Could not forward to {nameOf(f.id)}: {f.reason}</div>)}
    </div>}
    <div className="media-forward-footer">
      <button type="button" className="btn btn-secondary" onClick={closeForward}>Cancel</button>
      <button type="button" className="btn" disabled={busy || selected.length === 0 || tooLong} onClick={() => void send()}>{busy ? 'Sending…' : selected.length > 1 ? `Send (${selected.length})` : 'Send'}</button>
    </div>
  </div>;
}

/** The Forward dialog: pick up to 5 channels or conversations, add a comment, send. Mounted once by MediaHost. */
export function ForwardModal() {
  const message = useMedia(s => s.forwardTarget);
  return <Modal open={!!message} onClose={closeForward} title="Forward To" className="media-forward-dialog">
    {message && <ForwardBody key={message.id} message={message} />}
  </Modal>;
}
