// Custom emoji visuals shared by chat, the picker and settings: the image, the guild rail icon, and the in-message glyph with its
// hover tooltip and click popout (MSG-031).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { guildIconUrl, guildInitials, useStore } from '../api/store';
import type { Guild, Snowflake } from '../api/types';
import { AnimatedImage } from '../ui/AnimatedMedia';
import { emojiStore, findEmoji } from './store';
import './emoji.css';

export function GuildRailIcon({ guild, size = 24 }: { guild: Guild; size?: number }) {
  const icon = guildIconUrl(guild);
  return icon
    ? <img className="emoji-guild-icon" src={icon} alt="" width={size} height={size} draggable={false} />
    : <span className="emoji-guild-icon initials" style={{ width: size, height: size }} aria-hidden="true">{guildInitials(guild.name)}</span>;
}

const GAP = 8;
const EDGE = 8;
interface Placed { left: number; top: number; arrowLeft: number; below: boolean }

/** Centred on the anchor, above when there is room (else below), clamped to the viewport. */
function place(anchor: DOMRect, w: number, h: number, preferBelow: boolean): Placed {
  const cx = anchor.left + anchor.width / 2;
  const left = Math.min(Math.max(EDGE, cx - w / 2), Math.max(EDGE, window.innerWidth - w - EDGE));
  const fitsAbove = anchor.top - GAP - h >= EDGE;
  const fitsBelow = anchor.bottom + GAP + h <= window.innerHeight - EDGE;
  const below = preferBelow ? fitsBelow || !fitsAbove : !fitsAbove && fitsBelow;
  return { left, top: below ? anchor.bottom + GAP : anchor.top - GAP - h, arrowLeft: cx - left, below };
}

function usePlaced(anchor: DOMRect, preferBelow: boolean) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Placed | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (el) setPos(place(anchor, el.offsetWidth, el.offsetHeight, preferBelow));
  }, [anchor, preferBelow]);
  return { box, pos };
}

/** Where the emoji comes from, as the popout explains it. */
function useOrigin(id: Snowflake): { guild: Guild | null; known: boolean } {
  const byGuild = emojiStore(s => s.byGuild);
  const guilds = useStore(s => s.guilds);
  const found = findEmoji(id, { byGuild });
  return { guild: found ? guilds[found.guildId] ?? null : null, known: !!found };
}

/** `<:name:id>` inside message text: 22 px inline (48 px jumbo via `.md-jumbo`), hover tooltip, click popout. */
export function CustomEmojiGlyph({ id, name, animated, src }: { id: Snowflake; name: string; animated: boolean; src: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [broken, setBroken] = useState(false);
  const measure = () => setRect(ref.current?.getBoundingClientRect() ?? null);
  if (broken) return <>{`:${name}:`}</>;
  // The hover and click handlers sit on a wrapper because AnimatedImage owns the pointer handlers of the image it renders
  // (animated emoji follow the accessibility settings and show a still frame until hovered).
  const imgProps = { className: "md-emoji md-emoji-custom md-emoji-info", src, alt: `:${name}:`, draggable: false, loading: "lazy" as const, "data-emoji-id": id, onError: () => setBroken(true) };
  return <>
    <span ref={ref} className="md-emoji-wrap"
      onMouseEnter={() => { measure(); setHover(true); }}
      onMouseLeave={() => setHover(false)}
      onClick={e => { e.stopPropagation(); measure(); setHover(false); setOpen(true); }}>
      {animated ? <AnimatedImage kind="emoji" {...imgProps} /> : <img {...imgProps} />}
    </span>
    {hover && !open && rect && <Tip anchor={rect} name={name} src={src} />}
    {open && rect && <Pop anchor={rect} id={id} name={name} src={src} onClose={() => setOpen(false)} />}
  </>;
}

function Tip({ anchor, name, src }: { anchor: DOMRect; name: string; src: string }) {
  const { box, pos } = usePlaced(anchor, false);
  return createPortal(
    <div ref={box} className={`chat-emoji-tip${pos?.below ? ' below' : ''}`} role="tooltip"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden', ['--arrow-left' as string]: `${pos?.arrowLeft ?? 0}px` }}>
      <img className="emoji-tip-img" src={src} alt="" aria-hidden="true" />
      <span className="chat-emoji-tip-text"><b>:{name}:</b><span>Click to learn more</span></span>
    </div>,
    document.body,
  );
}

function Pop({ anchor, id, name, src, onClose }: { anchor: DOMRect; id: Snowflake; name: string; src: string; onClose: () => void }) {
  const { box, pos } = usePlaced(anchor, true);
  const { guild, known } = useOrigin(id);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('mousedown', onDown, true); };
  }, [onClose, box]);
  return createPortal(
    <div ref={box} className="chat-emoji-pop emoji-pop-custom" role="dialog" aria-label={`:${name}:`}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
      <img className="emoji-pop-img" src={src} alt="" aria-hidden="true" />
      <div className="chat-emoji-pop-body">
        <b>:{name}:</b>
        <p>{known && guild
          ? <>This emoji is from <strong>{guild.name}</strong>. You can use it anywhere on Vokko.</>
          : known ? 'A custom server emoji. You can use it anywhere on Vokko.' : 'This emoji belongs to a server you are not in, so you can’t use it.'}</p>
      </div>
    </div>,
    document.body,
  );
}
