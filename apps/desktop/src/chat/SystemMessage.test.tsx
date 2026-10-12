import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MessageType } from '../api/types';
import type { Message, User } from '../api/types';

const chatState = vi.hoisted(() => ({ type: 0 }));
vi.mock('./ChatContext', () => ({ useChat: () => ({ guildId: null, channel: { type: chatState.type }, isDm: chatState.type === 1 || chatState.type === 3, nameOf: (u: User) => u.username, actions: { jumpTo: () => undefined } }) }));
vi.mock('../threads/threadUi', () => ({ openThreadById: () => undefined, openThreadList: () => undefined }));
vi.mock('../api/store', () => ({ useStore: (select: (s: unknown) => unknown) => select({ me: { id: 'me' }, channels: {} }) }));
vi.mock('../voice/store', () => ({ useVoice: (select: (s: unknown) => unknown) => select({ channelId: null }) }));
vi.mock('../calls/engine', () => ({ startCall: () => undefined }));

const { SystemBody, joinLine } = await import('./SystemMessage');

const user = (username: string) => ({ id: username, username }) as User;
const message = (type: MessageType, extra: Partial<Message> = {}): Message =>
  ({ id: '1', channel_id: 'c', type, content: '', timestamp: new Date(Date.UTC(2026, 9, 10, 12, 0, 0)).toISOString(), author: user('sam'), mentions: [], ...extra }) as Message;
const render = (m: Message) => renderToStaticMarkup(<SystemBody message={m} name="Sam" />);
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'");

describe('SystemBody', () => {
  it('pin: muted pin icon, name, "a message" and "pinned messages" are buttons', () => {
    const html = render(message(MessageType.ChannelPinnedMessage, { message_reference: { message_id: '9', channel_id: 'c', guild_id: null } }));
    expect(html).toContain('chat-system-icon pin');
    expect(html).toContain('<button type="button" class="chat-system-name">Sam</button>');
    expect(html).toContain('<button type="button" class="chat-system-link">a message</button>');
    expect(html).toContain('<button type="button" class="chat-system-link">pinned messages</button>');
    expect(text(html)).toBe('Sam pinned a message to this channel. See all pinned messages.');
  });

  it('pin: "pinned messages" is a button only where the header pins popout belongs to the channel', () => {
    const pin = message(MessageType.ChannelPinnedMessage, { message_reference: { message_id: '9', channel_id: 'c', guild_id: null } });
    const button = '<button type="button" class="chat-system-link">pinned messages</button>';
    for (const type of [0, 1, 3, 5]) { // text, DM, group DM, announcement
      chatState.type = type;
      expect(render(pin)).toContain(button);
    }
    for (const type of [2, 11, 12, 13]) { // voice, public and private thread, stage
      chatState.type = type;
      const html = render(pin);
      expect(html).not.toContain(button);
      expect(html).toContain('<span class="chat-system-link-static">pinned messages</span>');
      expect(text(html)).toBe('Sam pinned a message to this channel. See all pinned messages.');
    }
    chatState.type = 0;
  });

  it('join: green arrow icon and the bold name inside one of the join lines', () => {
    const m = message(MessageType.UserJoin);
    const html = render(m);
    expect(html).toContain('chat-system-icon join');
    expect(html).toContain('<button type="button" class="chat-system-name">Sam</button>');
    const [before, after] = joinLine(m.timestamp);
    expect(text(html)).toBe(`${before}Sam${after}`);
  });

  it('thread created: thread icon, "started a thread" with the thread name as a link', () => {
    const html = render(message(MessageType.ThreadCreated, { content: 'gateway docs', message_reference: { message_id: '', channel_id: 't', guild_id: null } }));
    expect(html).toContain('chat-system-icon');
    expect(text(html)).toBe('Sam started a thread: gateway docs. See all threads.');
  });

  it('group add and remove (not sent by the server yet): add is green, remove is muted, both names open a profile', () => {
    const add = render(message(MessageType.RecipientAdd, { mentions: [user('alice')] }));
    expect(add).toContain('chat-system-icon join');
    expect(text(add)).toBe('Sam added alice to the group.');
    expect(add.match(/class="chat-system-name"/g)).toHaveLength(2);
    const remove = render(message(MessageType.RecipientRemove, { mentions: [user('alice')] }));
    expect(remove).toContain('chat-system-icon leave');
    expect(text(remove)).toBe('Sam removed alice from the group.');
    expect(remove.match(/class="chat-system-name"/g)).toHaveLength(2);
  });

  it('group leave (remove where the author is the removed user, or nobody is named): "left the group"', () => {
    expect(text(render(message(MessageType.RecipientRemove, { mentions: [user('sam')] })))).toBe('Sam left the group.');
    expect(text(render(message(MessageType.RecipientRemove)))).toBe('Sam left the group.');
  });

  it('add with nobody named falls back to "someone" (a plain name, no profile to open)', () => {
    const html = render(message(MessageType.RecipientAdd));
    expect(text(html)).toBe('Sam added someone to the group.');
    expect(html).toContain('<b>someone</b>');
  });

  it('rename (not sent by the server yet): "changed the channel name" with the new name', () => {
    const html = render(message(MessageType.ChannelNameChange, { content: 'lounge' }));
    expect(html).toContain('chat-system-icon');
    expect(html).toContain('<b>lounge</b>');
    expect(text(html)).toBe('Sam changed the channel name: lounge');
  });

  it('call (3): phone icon, ongoing, ended with its length, and missed by a user who never joined', () => {
    const started = Date.UTC(2026, 9, 10, 12, 0, 0);
    const call = (extra: Partial<Message>) => message(MessageType.Call, { content: '', timestamp: new Date(started).toISOString(), ...extra });
    const ongoing = render(call({ call: { participants: ['sam'], ended_timestamp: null } }));
    expect(ongoing).toContain('chat-system-icon join');
    expect(text(ongoing)).toBe('Sam started a call.');
    const ended = new Date(started + 5 * 60_000).toISOString();
    expect(text(render(call({ call: { participants: ['sam', 'me'], ended_timestamp: ended } })))).toBe('Sam started a call that lasted 5 minutes.');
    const missed = render(call({ call: { participants: ['sam'], ended_timestamp: ended } }));
    expect(missed).toContain('call-missed');
    expect(text(missed)).toBe('You missed a call from Sam that lasted 5 minutes.');
  });

  it('poll result (46): question, winner with its share, and a View Poll link', () => {
    const field = (name: string, value: string) => ({ name, value });
    const embed = { type: 'poll_result', fields: [field('poll_question_text', 'Lunch?'), field('victor_answer_id', '2'), field('victor_answer_text', 'Pizza'), field('victor_answer_votes', '3'), field('total_votes', '4')] };
    const html = render(message(MessageType.PollResult, { embeds: [embed] as Message['embeds'], message_reference: { message_id: '9', channel_id: 'c', guild_id: null } }));
    expect(html).toContain('chat-system-icon');
    expect(text(html).replace(/\s+/g, ' ').trim()).toBe("Sam's poll Lunch? has closed. Pizza won with 75% (3 votes). View Poll");
    const empty = message(MessageType.PollResult, { embeds: [{ type: 'poll_result', fields: [field('poll_question_text', 'Lunch?'), field('total_votes', '0')] }] as Message['embeds'] });
    expect(text(render(empty)).replace(/\s+/g, ' ').trim()).toBe("Sam's poll Lunch? has closed. Nobody voted.");
  });
});

describe('joinLine', () => {
  it('is stable for a timestamp, varies across timestamps and falls back for a bad one', () => {
    const at = (ms: number) => joinLine(new Date(ms).toISOString());
    const base = Date.UTC(2026, 9, 10, 12, 0, 0);
    expect(at(base)).toEqual(at(base));
    expect(new Set([0, 1, 2, 3, 4].map(n => at(base + n).join('|'))).size).toBe(5);
    expect(joinLine('not a date')).toEqual(['', ' joined the party.']);
  });
});
