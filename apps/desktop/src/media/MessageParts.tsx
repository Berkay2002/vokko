// Pieces MessageItem renders for the media features: sticker images, GIF-only messages and forwarded messages.
// Message content is only ever rendered as text or through the chat Markdown renderer, never as HTML.

import { useMemo, useState } from 'react';
import { Forward, ImageOff } from 'lucide-react';
import { ChannelType, StickerFormat, type Message, type StickerItem } from '../api/types';
import { Attachments } from '../chat/Attachments';
import { useChat } from '../chat/ChatContext';
import { Embeds } from '../chat/Embeds';
import { Markdown } from '../chat/markdown';
import { formatFullDate, formatMessageTimestamp } from '../chat/util';
import { gifMessageMedia, type GifMedia } from './helpers';
import { isKnownChannel, jumpToMessage } from './jump';
import { AnimatedImage, AnimatedVideo, Tooltip, dmName, resolveUrl, useStore } from './shell';

export { gifMessageMedia };

/** Sticker images of a message (animated formats are plain <img>s too). */
export function StickerItems({ items }: { items: StickerItem[] | undefined }) {
  if (!items?.length) return null;
  return <div className="media-stickers">
    {items.map(s => s.format_type === StickerFormat.PNG
      ? <img key={s.id} className="media-sticker" src={resolveUrl(s.url)} alt={`Sticker: ${s.name}`} title={s.name} width={160} height={160} loading="lazy" draggable={false} />
      : <AnimatedImage key={s.id} kind="sticker" className="media-sticker" src={resolveUrl(s.url)} alt={`Sticker: ${s.name}`} title={s.name} width={160} height={160} loading="lazy" draggable={false} />)}
  </div>;
}

const MAX_GIF_W = 400;
const MAX_GIF_H = 300;

/** A message that is just a GIF link: the media inline, the URL hidden. A broken image falls back to a small card with the link. */
export function GifMessage({ message, media }: { message: Pick<Message, 'id' | 'content'>; media: GifMedia }) {
  const chat = useChat();
  const [failed, setFailed] = useState(false);
  const pending = message.id.startsWith('pending:');
  const w = media.width ?? 320;
  const h = media.height ?? 240;
  const scale = Math.min(1, MAX_GIF_W / w, MAX_GIF_H / h);
  const size = { width: Math.max(60, Math.round(w * scale)), aspectRatio: `${w} / ${h}` };
  if (pending) return <div className="media-gif media-gif-pending" style={size} role="status" aria-label="Sending GIF" />;
  if (failed || (!media.src && !media.video)) {
    return <button type="button" className="media-gif media-gif-failed" onClick={() => chat.actions.openLink(media.url)}><ImageOff size={20} /> GIF unavailable &middot; open link</button>;
  }
  return <div className="media-gif" style={size}>
    {media.video
      ? <AnimatedVideo src={resolveUrl(media.video)} poster={media.src ? resolveUrl(media.src) : undefined} loop muted playsInline onError={() => setFailed(true)} />
      : <AnimatedImage kind="gif" src={resolveUrl(media.src ?? '')} alt="GIF" loading="lazy" draggable={false} onError={() => setFailed(true)} />}
    <span className="media-gif-badge" aria-hidden="true">GIF</span>
  </div>;
}

/** The message a forward points to, as the chat components expect it: the snapshot's content with a stand-in author. */
function snapshotView(message: Message): Message | null {
  const snap = message.message_snapshots?.[0]?.message;
  if (!snap) return null;
  return {
    ...message,
    // Not the forwarder: image tiles must not offer "remove from message", and the lightbox names the snapshot, not a person.
    author: { id: `forwarded:${message.id}`, username: 'Forwarded message', global_name: null, avatar: null, banner_color: null, bio: null, bot: false },
    member: undefined,
    content: snap.content,
    timestamp: snap.timestamp,
    edited_timestamp: snap.edited_timestamp,
    mentions: snap.mentions,
    mention_everyone: false,
    attachments: snap.attachments,
    embeds: snap.embeds,
    sticker_items: snap.sticker_items,
    reactions: [],
    pinned: false,
    message_reference: null,
    referenced_message: null,
    message_snapshots: undefined,
  };
}

/** A forwarded message: a quoted "Forwarded" block with the snapshot's content, media, original time and, when known, a jump to the original. */
export function ForwardedBlock({ message }: { message: Message }) {
  const chat = useChat();
  const view = useMemo(() => snapshotView(message), [message]);
  const ref = message.message_reference;
  const source = useStore(s => (ref ? s.channels[ref.channel_id] : undefined));
  if (!view) return null;
  // Snapshots carry no flags, so only the display settings gate the inline GIF (as in MessageItem).
  const gifOnly = gifMessageMedia(view);
  const gif = gifOnly && chat.display.showEmbeds && chat.display.inlineEmbedMedia ? gifOnly : null;
  const date = new Date(view.timestamp);
  const where = source ? (source.guild_id ? `#${source.name ?? 'channel'}` : source.type === ChannelType.GroupDM ? dmName(source) : `@${dmName(source)}`) : null;
  return <div className="media-forward" role="group" aria-label="Forwarded message">
    <div className="media-forward-head"><Forward size={14} aria-hidden="true" /> Forwarded</div>
    {gif ? <GifMessage message={view} media={gif} /> : view.content && <Markdown content={view.content} ctx={chat.md} className="chat-content" />}
    <Attachments message={view} />
    {!gifOnly && <Embeds message={view} />}
    <StickerItems items={view.sticker_items} />
    <div className="media-forward-foot">
      <Tooltip content={formatFullDate(date)} side="top"><time dateTime={view.timestamp}>{formatMessageTimestamp(date)}</time></Tooltip>
      {where && <span className="media-forward-where">{where}</span>}
      {ref && isKnownChannel(ref.channel_id) && <button type="button" className="media-forward-jump" onClick={() => void jumpToMessage(ref.channel_id, ref.message_id, ref.guild_id)}>Jump to original</button>}
    </div>
  </div>;
}
