import { useState, type RefObject } from 'react';
import { Search, Sticker as StickerIcon, X } from 'lucide-react';
import { Popout } from './shell';
import { EmojiPicker, type PickedEmoji } from './EmojiPicker';

export type ExpressionTab = 'gif' | 'sticker' | 'emoji';

const TABS: { id: ExpressionTab; label: string }[] = [
  { id: 'gif', label: 'GIFs' },
  { id: 'sticker', label: 'Stickers' },
  { id: 'emoji', label: 'Emoji' },
];

/** GIF / sticker tabs are visual shells: search box plus an honest empty state until the server has a provider for them. */
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

export function ExpressionPicker({ initialTab, onPickEmoji }: { initialTab: ExpressionTab; onPickEmoji: (e: PickedEmoji) => void }) {
  const [tab, setTab] = useState<ExpressionTab>(initialTab);
  return <div className="chat-expression-picker" role="dialog" aria-label="Expression picker">
    <div className="chat-expr-tabs" role="tablist">
      {TABS.map(t => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
    </div>
    {tab === 'emoji' ? <EmojiPicker embedded onPick={onPickEmoji} /> : <UnavailablePanel key={tab} tab={tab} />}
  </div>;
}

export function ExpressionPickerPopout({ anchor, open, initialTab, onClose, onPickEmoji }: {
  anchor: RefObject<HTMLElement | null>; open: boolean; initialTab: ExpressionTab; onClose: () => void; onPickEmoji: (e: PickedEmoji) => void;
}) {
  return <Popout anchor={anchor} open={open} onClose={onClose} side="top"><ExpressionPicker key={initialTab} initialTab={initialTab} onPickEmoji={onPickEmoji} /></Popout>;
}

/** Small popout for the "Apps" button: there are no apps yet. */
export function AppsPopout({ anchor, open, onClose }: { anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void }) {
  return <Popout anchor={anchor} open={open} onClose={onClose} side="top">
    <div className="chat-apps-panel" role="dialog" aria-label="Apps">
      <h3>Apps</h3>
      <p>Apps aren&rsquo;t available yet.</p>
    </div>
  </Popout>;
}
