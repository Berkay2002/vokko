import { useState, type RefObject } from 'react';
import { Search, Sticker as StickerIcon, X } from 'lucide-react';
import { BottomSheet, Popout, usePhone } from './shell';
import { EmojiPicker, type PickedEmoji } from './EmojiPicker';
import type { Gif, Snowflake, Sticker } from '../api/types';
import { GifPicker } from '../media/GifPicker';
import { StickerPicker } from '../media/StickerPicker';
import { recordGif, recordSticker } from '../media/store';

export type ExpressionTab = 'gif' | 'sticker' | 'emoji';

const TABS: { id: ExpressionTab; label: string }[] = [
  { id: 'gif', label: 'GIFs' },
  { id: 'sticker', label: 'Stickers' },
  { id: 'emoji', label: 'Emoji' },
];

/** Fallback when the composer passes no GIF or sticker handler: search box plus an empty state. */
function UnavailablePanel({ tab }: { tab: 'gif' | 'sticker' }) {
  const [query, setQuery] = useState('');
  const gif = tab === 'gif';
  return <div className="chat-expr-panel" role="tabpanel" aria-label={gif ? 'GIFs' : 'Stickers'}>
    <div className="chat-expr-search">
      <Search size={18} aria-hidden="true" />
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder={gif ? 'Search for GIFs' : 'Find the perfect sticker'} aria-label={gif ? 'Search GIFs' : 'Search stickers'} spellCheck={false} autoFocus />
      {query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><X size={16} /></button>}
    </div>
    <div className="chat-expr-empty">
      {gif ? <span className="chat-gif-glyph large" aria-hidden="true">GIF</span> : <StickerIcon size={48} aria-hidden="true" />}
      <h3>{gif ? 'GIFs aren\u2019t available yet' : 'Stickers aren\u2019t available yet'}</h3>
      <p>{gif ? 'GIF search will show up here once a GIF provider is connected.' : 'Stickers will show up here once sticker packs are available.'}</p>
    </div>
  </div>;
}

export function ExpressionPicker({ initialTab, onPickEmoji, channelId, onPickGif, onPickSticker }: {
  initialTab: ExpressionTab; onPickEmoji: (e: PickedEmoji) => void; channelId?: Snowflake; onPickGif?: (gif: Gif) => void; onPickSticker?: (sticker: Sticker) => void;
}) {
  const [tab, setTab] = useState<ExpressionTab>(initialTab);
  return <div className="chat-expression-picker" role="dialog" aria-label="Expression picker">
    <div className="chat-expr-tabs" role="tablist">
      {TABS.map(t => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
    </div>
    {tab === 'emoji' ? <EmojiPicker embedded onPick={onPickEmoji} />
      : tab === 'gif' && onPickGif ? <GifPicker onPick={gif => { recordGif(gif); onPickGif(gif); }} />
      : tab === 'sticker' && onPickSticker && channelId ? <StickerPicker channelId={channelId} onPick={sticker => { recordSticker(sticker.id); onPickSticker(sticker); }} />
      : <UnavailablePanel key={tab} tab={tab} />}
  </div>;
}

export function ExpressionPickerPopout({ anchor, open, initialTab, onClose, onPickEmoji, channelId, onPickGif, onPickSticker }: {
  anchor: RefObject<HTMLElement | null>; open: boolean; initialTab: ExpressionTab; onClose: () => void; onPickEmoji: (e: PickedEmoji) => void;
  channelId?: Snowflake; onPickGif?: (gif: Gif) => void; onPickSticker?: (sticker: Sticker) => void;
}) {
  const phone = usePhone();
  const picker = <ExpressionPicker key={initialTab} initialTab={initialTab} onPickEmoji={onPickEmoji} channelId={channelId} onPickGif={onPickGif} onPickSticker={onPickSticker} />;
  // On a phone the picker is a sheet docked under the composer, which stays visible above it.
  if (phone) return <BottomSheet dock open={open} onClose={onClose} anchor={anchor} label="Emoji, GIFs and stickers">{picker}</BottomSheet>;
  return <Popout anchor={anchor} open={open} onClose={onClose} side="top" align="end" className="chat-composer-picker">{picker}</Popout>;
}
