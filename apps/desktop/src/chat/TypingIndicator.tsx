import { useEffect, useState } from 'react';
import type { Snowflake } from '../api/types';
import { activeTypers } from './messageState';
import { useChannelState } from './messageStore';
import { useChat } from './ChatContext';

export function TypingIndicator({ channelId }: { channelId: Snowflake }) {
  const chat = useChat();
  const state = useChannelState(channelId);
  const [, tick] = useState(0);

  const expiries = Object.values(state.typing);
  const next = expiries.filter(t => t > Date.now()).sort((a, b) => a - b)[0];
  useEffect(() => {
    if (next === undefined) return;
    const t = setTimeout(() => tick(n => n + 1), Math.max(0, next - Date.now()) + 20);
    return () => clearTimeout(t);
  }, [next]);

  const ids = activeTypers(state, Date.now(), chat.me.id);
  const names = ids.map(id => {
    const u = chat.userById(id);
    return u ? chat.nameOf(u) : 'Someone';
  });

  let content: React.ReactNode = null;
  if (names.length === 1) content = <><b>{names[0]}</b> is typing…</>;
  else if (names.length === 2) content = <><b>{names[0]}</b> and <b>{names[1]}</b> are typing…</>;
  else if (names.length === 3) content = <><b>{names[0]}</b>, <b>{names[1]}</b>, and <b>{names[2]}</b> are typing…</>;
  else if (names.length > 3) content = <>Several people are typing…</>;

  return <div className="chat-typing" aria-live="polite">
    {content && <>
      <span className="chat-typing-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="chat-typing-text">{content}</span>
    </>}
  </div>;
}
