import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { emojiShortcodeLabel, useEmojiDb } from './emojiData';

const GAP = 8;
const EDGE = 8;

interface Placed { left: number; top: number; arrowLeft: number; below: boolean }

/** Centres a box on the anchor, above it when there is room (else below), clamped to the viewport. `arrowLeft` is the anchor centre inside the box. */
function place(anchor: DOMRect, w: number, h: number, preferBelow: boolean): Placed {
  const cx = anchor.left + anchor.width / 2;
  const left = Math.min(Math.max(EDGE, cx - w / 2), Math.max(EDGE, window.innerWidth - w - EDGE));
  const fitsAbove = anchor.top - GAP - h >= EDGE;
  const fitsBelow = anchor.bottom + GAP + h <= window.innerHeight - EDGE;
  const below = preferBelow ? fitsBelow || !fitsAbove : !fitsAbove && fitsBelow;
  const top = below ? anchor.bottom + GAP : anchor.top - GAP - h;
  return { left, top, arrowLeft: cx - left, below };
}

function useShortcode(unicode: string): string {
  useEmojiDb();
  return emojiShortcodeLabel(unicode);
}

/** A unicode emoji in message text: hover shows the name, click opens the "standard emoji" popout. */
export function EmojiGlyph({ unicode, name }: { unicode: string; name?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const shortcode = useShortcode(unicode);

  const measure = () => setRect(ref.current?.getBoundingClientRect() ?? null);
  return <>
    <span ref={ref} className="md-emoji md-emoji-info" role="img" aria-label={name ?? unicode}
      onMouseEnter={() => { measure(); setHover(true); }}
      onMouseLeave={() => setHover(false)}
      onClick={e => { e.stopPropagation(); measure(); setHover(false); setOpen(true); }}>{unicode}</span>
    {hover && !open && rect && <EmojiTooltip anchor={rect} unicode={unicode} shortcode={shortcode} />}
    {open && rect && <EmojiPopout anchor={rect} unicode={unicode} shortcode={shortcode} onClose={() => setOpen(false)} />}
  </>;
}

function EmojiTooltip({ anchor, unicode, shortcode }: { anchor: DOMRect; unicode: string; shortcode: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Placed | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (el) setPos(place(anchor, el.offsetWidth, el.offsetHeight, false));
  }, [anchor]);
  return createPortal(
    <div ref={box} className={`chat-emoji-tip${pos?.below ? ' below' : ''}`} role="tooltip"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden', ['--arrow-left' as string]: `${pos?.arrowLeft ?? 0}px` }}>
      <span className="chat-emoji-tip-glyph" aria-hidden="true">{unicode}</span>
      <span className="chat-emoji-tip-text">
        <b>{shortcode.startsWith(':') ? shortcode : unicode}</b>
        <span>Click to learn more</span>
      </span>
    </div>,
    document.body,
  );
}

function EmojiPopout({ anchor, unicode, shortcode, onClose }: { anchor: DOMRect; unicode: string; shortcode: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Placed | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (el) setPos(place(anchor, el.offsetWidth, el.offsetHeight, true));
  }, [anchor]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('mousedown', onDown, true); };
  }, [onClose]);
  return createPortal(
    <div ref={box} className="chat-emoji-pop" role="dialog" aria-label={shortcode}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
      <span className="chat-emoji-pop-glyph" aria-hidden="true">{unicode}</span>
      <div className="chat-emoji-pop-body">
        <b>{shortcode.startsWith(':') ? shortcode : unicode}</b>
        <p>A standard emoji. You can use this emoji anywhere on Vokko.</p>
      </div>
    </div>,
    document.body,
  );
}
