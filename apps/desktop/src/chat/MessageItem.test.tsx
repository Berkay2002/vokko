import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, type Message, type User } from '../api/types';

const display = vi.hoisted(() => ({ showEmbeds: true, inlineEmbedMedia: true, showCompactAvatars: false }));
const md = { userName: () => null, roleInfo: () => null, channelName: () => null };
vi.mock('./ChatContext', () => ({
  useChat: () => ({
    me: { id: 'me' }, guildId: null, members: {}, compact: false, isDm: false, canManage: false, canSend: true, replyingId: null, display, md,
    nameOf: (u: User) => u.username, colorOf: () => null, roleDotOf: () => null, userById: () => null, actions: {},
  }),
}));
// Stand-ins for the row's children: what is under test is which of them MessageItem picks for a GIF-only message.
vi.mock('./markdown', () => ({ Markdown: ({ content }: { content: string }) => <p className="chat-content">{content}</p> }));
vi.mock('./Embeds', () => ({ Embeds: () => <div className="chat-embeds" /> }));
vi.mock('../media/MessageParts', async () => ({
  gifMessageMedia: (await import('../media/helpers')).gifMessageMedia,
  GifMessage: () => <div className="media-gif" />, ForwardedBlock: () => null, StickerItems: () => null,
}));
vi.mock('./Avatar', () => ({ Avatar: () => null }));
vi.mock('./authorProfile', () => ({ useAuthorProfile: () => () => ({}) }));
vi.mock('./ServerTag', () => ({ ServerTag: () => null }));
vi.mock('./Attachments', () => ({ Attachments: () => null, PendingUpload: () => null }));
vi.mock('./MessageComponents', () => ({ MessageComponents: () => null }));
vi.mock('./Reactions', () => ({ Reactions: () => null }));
vi.mock('./EmojiPicker', () => ({ EmojiPickerPopout: () => null }));
vi.mock('./MessageMenu', () => ({ MessageMenu: () => null }));
vi.mock('./shell', async importOriginal => ({ ...await importOriginal<typeof import('./shell')>(), Tooltip: ({ children }: { children: unknown }) => children, roleIcon: () => null }));
vi.mock('../threads/ThreadChip', () => ({ ThreadChip: () => null }));
vi.mock('../threads/ThreadStarter', () => ({ ThreadStarter: () => null }));
vi.mock('../threads/useMessageActions', () => ({ useMessageThreadActions: () => ({}) }));
vi.mock('../polls/PollView', () => ({ PollView: () => null }));
vi.mock('../apps/InteractionMessage', () => ({ AppTag: () => null, EphemeralFooter: () => null, InteractionHeader: () => null, ThinkingBody: () => null, isEphemeral: () => false }));
vi.mock('./emojiData', () => ({ quickReactions: () => [] }));
vi.mock('./messageStore', () => ({ messageStore: {} }));
vi.mock('../media/store', () => ({ openForward: () => undefined }));

const { MessageItem } = await import('./MessageItem');

const message = (extra: Partial<Message> = {}): Message => ({
  id: '1', channel_id: 'c', type: 0, content: 'https://cdn.example/a/cat.gif', timestamp: new Date(Date.UTC(2026, 9, 10, 12)).toISOString(),
  author: { id: 'sam', username: 'sam' } as User, mentions: [], mention_everyone: false, attachments: [], embeds: [], ...extra,
}) as Message;
const render = (m: Message) => renderToStaticMarkup(<MessageItem message={m} pending={null} grouped={false} editing={false} highlighted={false} tabStop={false} onStopEditing={() => undefined} />);

describe('MessageItem GIF-only messages', () => {
  beforeEach(() => Object.assign(display, { showEmbeds: true, inlineEmbedMedia: true }));

  it('plays a direct GIF link inline in place of its URL', () => {
    const html = render(message());
    expect(html).toContain('media-gif');
    expect(html).not.toContain('chat-content');
  });

  it('keeps the link as text, once, with link media or embeds off or the previews removed', () => {
    for (const [prefs, flags] of [[{ inlineEmbedMedia: false }, 0], [{ showEmbeds: false }, 0], [{}, MessageFlags.SuppressEmbeds]] as const) {
      Object.assign(display, { showEmbeds: true, inlineEmbedMedia: true }, prefs);
      const html = render(message({ flags }));
      expect(html).not.toContain('media-gif');
      expect(html).toContain('<p class="chat-content">https://cdn.example/a/cat.gif</p>');
      // Embeds would show the same URL again as a text link (gifv/image card with link media off), so it is not mounted.
      expect(html).not.toContain('chat-embeds');
    }
  });
});
