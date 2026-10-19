/** The picture in the viewer: a scale and a pan offset (pixels from the centre of the stage), applied as one CSS transform. */
export interface View { scale: number; x: number; y: number }
export interface Size { w: number; h: number }
export interface Point { x: number; y: number }

export const RESET: View = { scale: 1, x: 0, y: 0 };
export const MAX_SCALE = 8;
/** A touch that moves less than this is a tap, not a drag. */
export const DRAG_SLOP = 6;
const SWIPE_DISTANCE = 50;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Keeps the scale in range and the picture covering the stage: no pan along an axis where the zoomed picture still fits. */
export function clampView(view: View, image: Size, stage: Size): View {
  const scale = clamp(view.scale, 1, MAX_SCALE);
  const reachX = Math.max(0, (image.w * scale - stage.w) / 2);
  const reachY = Math.max(0, (image.h * scale - stage.h) / 2);
  return { scale, x: clamp(view.x, -reachX, reachX), y: clamp(view.y, -reachY, reachY) };
}

/** Zooms to `scale` keeping the picture point under `at` (relative to the stage centre) where it is. */
export function zoomAt(view: View, scale: number, at: Point, image: Size, stage: Size): View {
  const next = clamp(scale, 1, MAX_SCALE);
  const k = next / view.scale;
  return clampView({ scale: next, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k }, image, stage);
}

/** Two fingers: the scale follows their distance, the picture follows their midpoint. */
export function pinch(start: View, startDistance: number, startMid: Point, distance: number, mid: Point, image: Size, stage: Size): View {
  const zoomed = zoomAt(start, start.scale * (distance / Math.max(1, startDistance)), startMid, image, stage);
  return clampView({ ...zoomed, x: zoomed.x + mid.x - startMid.x, y: zoomed.y + mid.y - startMid.y }, image, stage);
}

/** The scale a click zooms to: the picture's real size, but at least 2x (a small picture has no more detail to show). */
export const clickScale = (naturalWidth: number, shownWidth: number): number => clamp(Math.max(2, naturalWidth / Math.max(1, shownWidth)), 2, MAX_SCALE);

/** A touch release as a viewer move: 1 next picture, -1 previous, 0 none. Needs a mostly horizontal drag of at least 50 px. */
export function swipeStep(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}
