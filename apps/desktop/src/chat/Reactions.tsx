import { useRef, useState } from 'react';
import { SmilePlus } from 'lucide-react';
import type { Message, Reaction, ReactionEmoji, User } from '../api/types';
import { AnimatedImage, request, Tooltip } from './shell';
import { useChat } from './ChatContext';
import { emojiKey } from './messageState';
import { EmojiPickerPopout } from './EmojiPicker';
import { useCustomEmojiUrl } from '../emoji/store';

function emojiNode(e: ReactionEmoji, customUrl: string | null) {
  if (e.id && customUrl) return <AnimatedImage kind="emoji" className="chat-reaction-emoji" src={customUrl} alt={`:${e.name}:`} draggable={false} data-emoji-id={e.id} />;
  if (e.id) return <span className="chat-reaction-emoji chat-reaction-emoji-text">:{e.name}:</span>;
  return <span className="chat-reaction-emoji" role="img" aria-label={e.name}>{e.name}</span>;
}

function whoText(users: User[], total: number, emoji: ReactionEmoji, name: (u: User) => string): string {
  const label = emoji.id ? `:${emoji.name}:` : emoji.name;
  const names = users.slice(0, 3).map(name);
  const rest = total - names.length;
  if (names.length === 0) return `reacted with ${label}`;
  if (rest > 0) return `${names.join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'} reacted with ${label}`;
  if (names.length === 1) return `${names[0]} reacted with ${label}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} reacted with ${label}`;
}

function ReactionPill({ message, reaction }: { message: Message; reaction: Reaction }) {
  const chat = useChat();
  const [who, setWho] = useState<string | null>(null);
  const fetched = useRef<number>(-1);
  const key = emojiKey(reaction.emoji);
  const customUrl = useCustomEmojiUrl();

  function load() {
    if (fetched.current === reaction.count) return;
    fetched.current = reaction.count;
    request<User[]>('GET', `/channels/${message.channel_id}/messages/${message.id}/reactions/${encodeURIComponent(key)}`)
      .then(users => setWho(whoText(users, reaction.count, reaction.emoji, u => chat.nameOf(u))))
      .catch(() => setWho(null));
  }

  return <Tooltip content={who ?? 'Loading…'} side="top">
    <button type="button" className={`chat-reaction${reaction.me ? ' me' : ''}`} aria-pressed={reaction.me} aria-label={`${reaction.count} ${reaction.emoji.name}`}
      onMouseEnter={load} onFocus={load} onClick={() => chat.actions.react(message, reaction.emoji)}>
      {emojiNode(reaction.emoji, reaction.emoji.id ? customUrl(reaction.emoji.id) : null)}
      <span className="chat-reaction-count">{reaction.count}</span>
    </button>
  </Tooltip>;
}

export function Reactions({ message }: { message: Message }) {
  const chat = useChat();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (message.reactions.length === 0 || !chat.display.showReactions) return null;
  return <div className="chat-reactions" role="group" aria-label="Reactions">
    {message.reactions.map(r => <ReactionPill key={emojiKey(r.emoji)} message={message} reaction={r} />)}
    <button ref={anchor} type="button" className="chat-reaction chat-reaction-add" aria-label="Add Reaction" onClick={() => setOpen(true)}><SmilePlus size={16} /></button>
    <EmojiPickerPopout anchor={anchor} open={open} onClose={() => setOpen(false)} onPick={e => { setOpen(false); chat.actions.react(message, e); }} />
  </div>;
}
