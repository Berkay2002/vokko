export type Side = "top" | "bottom" | "left" | "right";
export type Align = "start" | "center" | "end";

const MARGIN = 8;

/** Position a floating box next to an anchor rect; flips to the opposite side when it would overflow, then clamps to the viewport. */
export function placeNear(anchor: DOMRect, width: number, height: number, side: Side, gap = 8, align: Align = "center"): { left: number; top: number; side: Side } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fits: Record<Side, boolean> = {
    top: anchor.top - gap - height >= MARGIN,
    bottom: anchor.bottom + gap + height <= vh - MARGIN,
    left: anchor.left - gap - width >= MARGIN,
    right: anchor.right + gap + width <= vw - MARGIN,
  };
  const opposite: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };
  const used: Side = fits[side] || !fits[opposite[side]] ? side : opposite[side];
  let left: number;
  let top: number;
  if (used === "top" || used === "bottom") {
    top = used === "top" ? anchor.top - gap - height : anchor.bottom + gap;
    left = align === "start" ? anchor.left : align === "end" ? anchor.right - width : anchor.left + anchor.width / 2 - width / 2;
  } else {
    left = used === "left" ? anchor.left - gap - width : anchor.right + gap;
    top = align === "start" ? anchor.top : align === "end" ? anchor.bottom - height : anchor.top + anchor.height / 2 - height / 2;
  }
  left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, vw - width - MARGIN));
  top = Math.min(Math.max(top, MARGIN), Math.max(MARGIN, vh - height - MARGIN));
  return { left, top, side: used };
}

/** Position a box at a point (context menus): shift left/up when it would overflow. */
export function placeAtPoint(x: number, y: number, width: number, height: number): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = x + width + MARGIN > vw ? Math.max(MARGIN, x - width) : x;
  const top = y + height + MARGIN > vh ? Math.max(MARGIN, vh - height - MARGIN) : y;
  return { left, top };
}
