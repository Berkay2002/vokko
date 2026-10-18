import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { Message, Reaction, User } from '../api/types';
import { Modal, request } from './shell';
import { useChat } from './ChatContext';
import { Avatar } from './Avatar';
import { emojiKey } from './messageState';

/** Super reactors first (marked), then normal reactors. */
type Loaded = { user: User; burst: boolean }[] | 'error';

function EmojiFace({ reaction }: { reaction: Reaction }) {
  const e = reaction.emoji;
  return e.id ? <span className="chat-reactions-custom">:{e.name}:</span> : <span className="chat-reactions-glyph" role="img" aria-label={e.name}>{e.name}</span>;
}

/** "View Reactions": one tab per emoji, listing the users who reacted (GET .../reactions/{emoji}). */
export function ReactionsModal({ message, initialKey, onClose }: { message: Message | null; initialKey?: string; onClose: () => void }) {
  const chat = useChat();
  const reactions = message?.reactions ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [cache, setCache] = useState<Record<string, Loaded>>({});
  const messageId = message?.id;

  useEffect(() => { setSelected(initialKey ?? null); setCache({}); }, [messageId, initialKey]);

  const active = reactions.find(r => emojiKey(r.emoji) === selected) ?? reactions[0];
  const key = active ? emojiKey(active.emoji) : null;

  useEffect(() => {
    if (!message || !key || cache[key]) return;
    let live = true;
    const url = `/channels/${message.channel_id}/messages/${message.id}/reactions/${encodeURIComponent(key)}`;
    const wantsBurst = (active?.count_details.burst ?? 0) > 0;
    Promise.all([wantsBurst ? request<User[]>('GET', `${url}?type=1`) : Promise.resolve([]), request<User[]>('GET', url)])
      .then(([bursts, normals]) => { if (live) setCache(c => ({ ...c, [key]: [...bursts.map(user => ({ user, burst: true })), ...normals.map(user => ({ user, burst: false }))] })); })
      .catch(() => { if (live) setCache(c => ({ ...c, [key]: 'error' })); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message?.id, key]);

  const users = key ? cache[key] : undefined;
  return <Modal open={!!message} onClose={onClose} title="Reactions" className="chat-reactions-modal">
    <div className="chat-reactions-body">
      <div className="chat-reactions-rail" role="tablist" aria-label="Reactions" aria-orientation="vertical">
        {reactions.map(r => {
          const k = emojiKey(r.emoji);
          return <button key={k} type="button" role="tab" aria-selected={k === key} className={k === key ? 'active' : ''} onClick={() => setSelected(k)}>
            <EmojiFace reaction={r} /><span className="chat-reactions-count">{r.count}</span>
          </button>;
        })}
      </div>
      <ul className="chat-reactions-users" aria-label="Users who reacted">
        {users === undefined && <li className="chat-reactions-note">Loading…</li>}
        {users === 'error' && <li className="chat-reactions-note">Couldn&rsquo;t load reactions.</li>}
        {Array.isArray(users) && users.length === 0 && <li className="chat-reactions-note">No one reacted with this emoji.</li>}
        {Array.isArray(users) && users.map(({ user: u, burst }) => <li key={`${u.id}:${burst ? 1 : 0}`} className="chat-reactions-user">
          <Avatar user={u} size={32} />
          <span className="chat-reactions-name">{chat.nameOf(u)}</span>
          <span className="chat-reactions-username">{u.username}</span>
          {burst && <span className="reactions-super-badge" title="Super Reaction" aria-label="Super Reaction"><Sparkles size={16} /></span>}
        </li>)}
      </ul>
    </div>
  </Modal>;
}
