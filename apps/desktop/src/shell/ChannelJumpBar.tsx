// Discord's "New Unreads" / "New Mentions" pills over the channel list: an unread or mentioned row scrolled out of view
// above or below shows a pill at that edge, and a click scrolls the nearest one in.
import { useEffect, useRef, useState, type ReactNode } from "react";

type Kind = "unread" | "mention" | null;
type Side = -1 | 0 | 1;

const ROWS = "a.channel-row.unread, a.channel-row:has(> .count-badge)";
const kindOf = (el: Element): Kind => (el.querySelector(":scope > .count-badge") ? "mention" : "unread");

/** `ref` goes on the scroller; `top` is rendered as its first child and `bottom` as its last (both are sticky). */
export function useChannelJump(): { ref: (el: HTMLElement | null) => void; top: ReactNode; bottom: ReactNode } {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [hidden, setHidden] = useState<{ above: Kind; below: Kind }>({ above: null, below: null });
  const rows = useRef<Map<Element, Side>>(new Map());

  useEffect(() => {
    if (!scroller) return;
    const where = (rows.current = new Map<Element, Side>());
    const update = () => {
      let above: Kind = null;
      let below: Kind = null;
      for (const [el, side] of where) {
        if (side === 0) continue;
        const kind = kindOf(el);
        if (side < 0) above = above === "mention" ? above : kind;
        else below = below === "mention" ? below : kind;
      }
      setHidden(prev => (prev.above === above && prev.below === below ? prev : { above, below }));
    };
    const io = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          if (!where.has(e.target)) continue;
          where.set(e.target, e.isIntersecting ? 0 : e.boundingClientRect.top < (e.rootBounds?.top ?? 0) ? -1 : 1);
        }
        update();
      },
      { root: scroller },
    );
    // Rows come and go (route change, a category collapses) and turn unread or mentioned: re-collect on DOM changes.
    const collect = () => {
      const now = new Set(scroller.querySelectorAll(ROWS));
      for (const el of where.keys()) {
        if (!now.has(el)) {
          io.unobserve(el);
          where.delete(el);
        }
      }
      for (const el of now) {
        if (!where.has(el)) {
          where.set(el, 0);
          io.observe(el);
        }
      }
      update();
    };
    const mo = new MutationObserver(collect);
    mo.observe(scroller, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    collect();
    return () => {
      mo.disconnect();
      io.disconnect();
    };
  }, [scroller]);

  const jump = (side: Side) => {
    const out = [...rows.current].filter(([el, s]) => s === side && el.isConnected).map(([el]) => el);
    out.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    (side < 0 ? out[out.length - 1] : out[0])?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const pill = (kind: Kind, side: Side) =>
    kind && (
      <div className={`channel-jump ${side < 0 ? "top" : "bottom"}`}>
        <button type="button" className={`channel-jump-pill${kind === "mention" ? " mention" : ""}`} onClick={() => jump(side)}>
          {kind === "mention" ? "New Mentions" : "New Unreads"}
        </button>
      </div>
    );
  return { ref: setScroller, top: pill(hidden.above, -1), bottom: pill(hidden.below, 1) };
}
