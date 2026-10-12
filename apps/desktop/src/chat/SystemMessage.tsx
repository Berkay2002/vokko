import { ArrowRightFromLine, PenLine, Pin, UserMinus, UserPlus } from 'lucide-react';
import { MessageType } from '../api/types';
import type { Message } from '../api/types';
import { CallNotice } from '../calls/CallNotice';
import { PollResultNotice } from '../polls/PollResultNotice';
import { ThreadCreatedNotice } from '../threads/ThreadNotice';
import { useChat } from './ChatContext';

// Join lines rotate: picked from the timestamp, so every client shows the same line for a message. The copy is not checked against Discord's yet (join was not captured).
const JOIN_LINES: readonly (readonly [string, string])[] = [
  ['', ' joined the party.'],
  ['Welcome, ', '. We hope you brought snacks.'],
  ['', ' just showed up.'],
  ['', ' just landed.'],
  ['Everyone welcome ', '!'],
  ['Good to see you, ', '.'],
  ['', ' hopped into the server.'],
  ['Glad you are here, ', '.'],
  ['', ' just slid into the server.'],
  ['Say hi to ', '!'],
];

/** Text before and after the member's name in a join message. */
export function joinLine(timestamp: string): readonly [string, string] {
  const ms = Date.parse(timestamp);
  return JOIN_LINES[Number.isFinite(ms) ? ms % JOIN_LINES.length : 0]!;
}

/** Body of a system row: icon in the gutter and the muted line. The server posts call (3), pin (6), join (7), thread created (18) and poll result (46); 1, 2 and 4 are group-DM and rename rows it does not send yet. */
export function SystemBody({ message, name }: { message: Message; name: string }) {
  const chat = useChat();
  const first = message.mentions[0];
  const other = first ? chat.nameOf(first) : 'someone';
  switch (message.type) {
    case MessageType.ChannelPinnedMessage:
      return <><Pin size={18} className="chat-system-icon pin" /><span className="chat-system-text"><b>{name}</b> pinned <button type="button" className="chat-system-link" onClick={() => message.message_reference && chat.actions.jumpTo(message.message_reference.message_id)}>a message</button> to this channel. See all <span className="chat-system-link-static">pinned messages</span>.</span></>;
    case MessageType.UserJoin: {
      const [before, after] = joinLine(message.timestamp);
      return <><ArrowRightFromLine size={18} className="chat-system-icon join" /><span className="chat-system-text">{before}<b>{name}</b>{after}</span></>;
    }
    case MessageType.RecipientAdd:
      return <><UserPlus size={18} className="chat-system-icon join" /><span className="chat-system-text"><b>{name}</b> added <b>{other}</b> to the group.</span></>;
    case MessageType.RecipientRemove:
      return <><UserMinus size={18} className="chat-system-icon leave" /><span className="chat-system-text"><b>{name}</b> removed <b>{other}</b> from the group.</span></>;
    case MessageType.ChannelNameChange:
      return <><PenLine size={18} className="chat-system-icon" /><span className="chat-system-text"><b>{name}</b> changed the channel name: <b>{message.content}</b></span></>;
    case MessageType.ThreadCreated:
      return <ThreadCreatedNotice message={message} name={name} />;
    case MessageType.Call:
      return <CallNotice message={message} name={name} />;
    case MessageType.PollResult:
      return <PollResultNotice message={message} name={name} />;
    default:
      return <span className="chat-system-text">{message.content}</span>;
  }
}
