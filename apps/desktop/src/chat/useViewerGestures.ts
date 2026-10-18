import { useEffect, useRef, useState, type RefObject } from 'react';
import { DRAG_SLOP, RESET, clampView, clickScale, pinch, swipeStep, zoomAt, type Point, type Size, type View } from './lightboxZoom';

interface Options {
  stage: RefObject<HTMLDivElement | null>;
  image: RefObject<HTMLImageElement | null>;
  view: View;
  setView(view: View): void;
  /** More than one picture: a horizontal touch swipe moves between them. */
  canSwipe: boolean;
  /** -1 previous, 1 next. */
  step(direction: -1 | 1): void;
}

/**
 * Pointer, wheel and trackpad-gesture handling for the image viewer. The stage has `touch-action: none`, so a finger never scrolls the
 * page behind the viewer; instead one finger pans a zoomed picture (or swipes between pictures at 1x), two fingers pinch, Ctrl+wheel
 * and a trackpad pinch zoom at the pointer, and a plain wheel pans a zoomed picture. A drag must not end in the click that toggles
 * the zoom: `zoomed` toggles only through `toggle`, which ignores the click that follows a drag.
 */
export function useViewerGestures(opts: Options): { dragging: boolean; toggle(clientX: number, clientY: number): void } {
  const latest = useRef(opts);
  latest.current = opts;
  const [dragging, setDragging] = useState(false);
  const moved = useRef(false);

  const measure = (): { image: Size; stage: Size; center: Point } | null => {
    const { stage, image } = latest.current;
    if (!stage.current || !image.current) return null;
    const box = stage.current.getBoundingClientRect();
    return { image: { w: image.current.offsetWidth, h: image.current.offsetHeight }, stage: { w: box.width, h: box.height }, center: { x: box.left + box.width / 2, y: box.top + box.height / 2 } };
  };

  useEffect(() => {
    const el = latest.current.stage.current;
    if (!el) return;
    const pointers = new Map<number, Point>();
    let base: { view: View; at: Point; distance: number; mid: Point; touch: boolean } | null = null;
    let gestureStart = 1;

    const rel = (p: Point, center: Point): Point => ({ x: p.x - center.x, y: p.y - center.y });
    const pair = (): [Point, Point] | null => (pointers.size === 2 ? ([...pointers.values()] as [Point, Point]) : null);
    const rebase = (): void => {
      const m = measure();
      const two = pair();
      const [only] = pointers.values();
      if (!m || !(two || only)) { base = null; return; }
      const a = two?.[0] ?? only!;
      const b = two?.[1] ?? only!;
      base = { view: latest.current.view, at: { ...a }, distance: Math.hypot(a.x - b.x, a.y - b.y), mid: rel({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, m.center), touch: base?.touch ?? false };
    };

    const down = (e: PointerEvent): void => {
      if ((e.target as Element).closest('button, a') || (e.pointerType === 'mouse' && e.button !== 0)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) moved.current = false;
      rebase();
      if (base) base.touch = e.pointerType !== 'mouse';
      if (pointers.size === 2) moved.current = true;
    };
    const move = (e: PointerEvent): void => {
      if (!pointers.has(e.pointerId) || !base) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const m = measure();
      if (!m) return;
      const two = pair();
      const { setView, canSwipe } = latest.current;
      if (two) {
        setDragging(true);
        const mid = rel({ x: (two[0].x + two[1].x) / 2, y: (two[0].y + two[1].y) / 2 }, m.center);
        setView(pinch(base.view, base.distance, base.mid, Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y), mid, m.image, m.stage));
        return;
      }
      const dx = e.clientX - base.at.x;
      const dy = e.clientY - base.at.y;
      if (!moved.current && Math.hypot(dx, dy) < DRAG_SLOP) return;
      moved.current = true;
      setDragging(true);
      if (base.view.scale > 1) setView(clampView({ ...base.view, x: base.view.x + dx, y: base.view.y + dy }, m.image, m.stage));
      else if (canSwipe && base.touch) setView({ ...RESET, x: dx }); // the picture follows the finger; it snaps back or changes on release
    };
    const up = (e: PointerEvent): void => {
      if (!pointers.has(e.pointerId)) return;
      const was = base;
      const last = pointers.get(e.pointerId)!;
      pointers.delete(e.pointerId);
      const { setView, step, canSwipe, view } = latest.current;
      if (pointers.size > 0) { rebase(); return; } // one finger of a pinch lifted: the other carries on as a pan
      setDragging(false);
      base = null;
      setTimeout(() => { moved.current = false; }, 0); // the click that follows this pointerup still sees the drag
      if (!was) return;
      if (view.scale < 1.05) {
        const dir = e.type === 'pointerup' && was.view.scale === 1 && canSwipe && was.touch ? swipeStep(last.x - was.at.x, last.y - was.at.y) : 0;
        setView(RESET);
        if (dir) step(dir);
      }
    };
    const wheel = (e: WheelEvent): void => {
      e.preventDefault(); // the stage covers the page: neither the page zoom (Ctrl+wheel) nor the message list behind it may move
      const m = measure();
      if (!m) return;
      const { view, setView } = latest.current;
      const unit = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey) setView(zoomAt(view, view.scale * Math.exp(-e.deltaY * unit * 0.005), rel({ x: e.clientX, y: e.clientY }, m.center), m.image, m.stage));
      else if (view.scale > 1) setView(clampView({ ...view, x: view.x - e.deltaX * unit, y: view.y - e.deltaY * unit }, m.image, m.stage));
    };
    // WebKit (the macOS webview) reports a trackpad pinch as gesture events, not Ctrl+wheel.
    type GestureEvent = Event & { scale: number; clientX: number; clientY: number };
    const gestureStartFn = (e: Event): void => { e.preventDefault(); gestureStart = latest.current.view.scale; };
    const gestureChange = (e: Event): void => {
      e.preventDefault();
      const m = measure();
      const g = e as GestureEvent;
      if (!m || pointers.size > 1) return; // a touch pinch is handled by the pointer events
      const { view, setView } = latest.current;
      setView(zoomAt(view, gestureStart * g.scale, rel({ x: g.clientX, y: g.clientY }, m.center), m.image, m.stage));
    };

    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('gesturestart', gestureStartFn);
    el.addEventListener('gesturechange', gestureChange);
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('gesturestart', gestureStartFn);
      el.removeEventListener('gesturechange', gestureChange);
    };
  }, []);

  const toggle = (clientX: number, clientY: number): void => {
    if (moved.current) return;
    const { view, setView, image } = latest.current;
    const m = measure();
    if (view.scale > 1 || !m || !image.current) { setView(RESET); return; }
    setView(zoomAt(view, clickScale(image.current.naturalWidth, m.image.w), { x: clientX - m.center.x, y: clientY - m.center.y }, m.image, m.stage));
  };
  return { dragging, toggle };
}
