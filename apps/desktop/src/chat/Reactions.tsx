import { useRef, useState, type MouseEvent } from 'react';
import { SmilePlus } from 'lucide-react';
import type { Message, Reaction, ReactionEmoji, User } from '../api/types';
import { AnimatedImage, request, Tooltip, usePhone } from './shell';
import { useChat } from './ChatContext';
import { emojiKey } from './messageState';
import { EmojiPickerPopout } from './EmojiPicker';
import { BurstPill, SplitReactors, whoLine } from '../perks/SuperReactions';
import { externalEmojiBlocked, findEmoji, useCanUseExternalEmoji, useCustomEmojiUrl } from '../emoji/store';
import { chatToast } from './toast';

function emojiNode(e: ReactionEmoji, customUrl: string | null) {
  if (e.id && customUrl) return <AnimatedImage kind="emoji" className="chat-reaction-emoji" src={customUrl} alt={`:${e.name}:`} draggable={false} data-emoji-id={e.id} />;
  if (e.id) return <span className="chat-reaction-emoji chat-reaction-emoji-text">:{e.name}:</span>;
  return <span className="chat-reaction-emoji" role="img" aria-label={e.name}>{e.name}</span>;
}

type Who = { burst: string | null; normal: string | null };

/** Loads who reacted (normal and super separately, `?type=1` for super) the first time a pill of this emoji is hovered or its counts change. */
function useReactors(message: Message, reaction: Reaction): { who: Who | null; load: () => void } {
  const chat = useChat();
  const [who, setWho] = useState<Who | null>(null);
  const fetched = useRef('');
  const key = emojiKey(reaction.emoji);
  const { burst, normal } = reaction.count_details;
  const label = reaction.emoji.id ? `:${reaction.emoji.name}:` : reaction.emoji.name;

  function load() {
    const stamp = `${burst}/${normal}`;
    if (fetched.current === stamp) return;
    fetched.current = stamp;
    const url = `/channels/${message.channel_id}/messages/${message.id}/reactions/${encodeURIComponent(key)}`;
    const line = async (count: number, isBurst: boolean): Promise<string | null> => {
      if (count === 0) return null;
      const users = await request<User[]>('GET', isBurst ? `${url}?type=1` : url);
      return whoLine(users.map(u => chat.nameOf(u)), count, label, isBurst);
    };
    Promise.all([line(burst, true), line(normal, false)]).then(([b, n]) => setWho({ burst: b, normal: n })).catch(() => setWho(null));
  }
  return { who, load };
}

function ReactionPills({ message, reaction }: { message: Message; reaction: Reaction }) {
  const chat = useChat();
  const { who, load } = useReactors(message, reaction);
  const customUrl = useCustomEmojiUrl();
  const { channel, canExternal } = useCanUseExternalEmoji(message.channel_id);
  const tip = who ? <SplitReactors burst={who.burst} normal={who.normal} /> : 'Loading…';
  const { burst, normal } = reaction.count_details;
  const phone = usePhone();
  const emojiId = reaction.emoji.id;
  const emoji = emojiNode(reaction.emoji, emojiId ? customUrl(emojiId) : null);
  // adding a reaction the server would refuse here (removing your own is always allowed)
  const toggle = (isBurst: boolean) => {
    const mine = isBurst ? reaction.me_burst : reaction.me;
    if (!mine && emojiId && externalEmojiBlocked(findEmoji(emojiId)?.guildId, channel, canExternal)) chatToast("You can't add emoji from other servers in this channel.");
    else chat.actions.react(message, reaction.emoji, isBurst);
  };
  // Phone: a long press on a pill lists who reacted (the reactions sheet on this emoji); desktop right-click keeps the message menu.
  const showWho = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); chat.actions.viewReactions(message, emojiKey(reaction.emoji)); };
  return <span style={{ display: 'contents' }} data-long-press={phone ? '' : undefined} onContextMenu={phone ? showWho : undefined}>
    {burst > 0 && <Tooltip content={tip} side="top">
      <BurstPill messageId={message.id} emojiKey={emojiKey(reaction.emoji)} reaction={reaction} emoji={emoji} label={`${burst} super ${reaction.emoji.name}`} onHover={load}
        onClick={() => toggle(true)} />
    </Tooltip>}
    {normal > 0 && <Tooltip content={tip} side="top">
      <button type="button" className={`chat-reaction${reaction.me ? ' me' : ''}`} aria-pressed={reaction.me} aria-label={`${normal} ${reaction.emoji.name}`}
        onMouseEnter={load} onFocus={load} onClick={() => toggle(false)}>
        {emoji}
        <span className="chat-reaction-count">{normal}</span>
      </button>
    </Tooltip>}
  </span>;
}

export function Reactions({ message }: { message: Message }) {
  const chat = useChat();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (message.reactions.length === 0 || !chat.display.showReactions) return null;
  return <div className="chat-reactions" role="group" aria-label="Reactions">
    {message.reactions.map(r => <ReactionPills key={emojiKey(r.emoji)} message={message} reaction={r} />)}
    <button ref={anchor} type="button" className="chat-reaction chat-reaction-add" aria-label="Add Reaction" onClick={() => setOpen(true)}><SmilePlus size={16} /></button>
    <EmojiPickerPopout anchor={anchor} open={open} onClose={() => setOpen(false)} superReactions onPick={(e, burst) => { setOpen(false); chat.actions.react(message, e, burst); }} reactionChannelId={message.channel_id} />
  </div>;
}
