import { describe, expect, it } from 'vitest';
import { MAX_SCALE, RESET, clampView, clickScale, pinch, swipeStep, zoomAt } from './lightboxZoom';
import { fileNameFromUrl } from './mediaTarget';

const stage = { w: 1000, h: 600 };
const image = { w: 800, h: 600 };

describe('viewer zoom', () => {
  it('keeps the point under the pointer where it is', () => {
    const v = zoomAt(RESET, 2, { x: 200, y: 100 }, image, stage);
    expect(v.scale).toBe(2);
    expect(v.x).toBeCloseTo(-200); // at - (at - 0) * 2: the picture grew away from the pointer's left side
    expect(v.y).toBeCloseTo(-100);
  });

  it('cannot pan along an axis where the zoomed picture still fits the stage', () => {
    const v = clampView({ scale: 1.2, x: 500, y: 500 }, image, stage); // 960 wide < 1000: no horizontal reach
    expect(v.x).toBe(0);
    expect(v.y).toBe(60); // 600 * 1.2 = 720 against 600: 60 px of slack on each side
  });

  it('limits the scale to 1..MAX_SCALE', () => {
    expect(zoomAt(RESET, 0.2, { x: 0, y: 0 }, image, stage).scale).toBe(1);
    expect(zoomAt(RESET, 99, { x: 0, y: 0 }, image, stage).scale).toBe(MAX_SCALE);
  });

  it('a pinch scales by the finger distance and follows the midpoint', () => {
    const v = pinch(RESET, 100, { x: 0, y: 0 }, 300, { x: 40, y: 0 }, image, stage);
    expect(v.scale).toBe(3);
    expect(v.x).toBe(40);
  });

  it('a click zooms to the real size, at least 2x', () => {
    expect(clickScale(4000, 1000)).toBe(4);
    expect(clickScale(900, 1000)).toBe(2);
    expect(clickScale(80000, 1000)).toBe(MAX_SCALE);
  });

  it('a swipe needs a long, mostly horizontal drag', () => {
    expect(swipeStep(-80, 10)).toBe(1);
    expect(swipeStep(80, -10)).toBe(-1);
    expect(swipeStep(-30, 0)).toBe(0);
    expect(swipeStep(-80, 70)).toBe(0); // a vertical scroll attempt
  });
});

describe('fileNameFromUrl', () => {
  it('prefers the known name, else the decoded last path segment', () => {
    expect(fileNameFromUrl('https://x/a/b.png', 'cat.png')).toBe('cat.png');
    expect(fileNameFromUrl('https://x/a/my%20pic.png?x=1')).toBe('my pic.png');
    expect(fileNameFromUrl('https://x/')).toBe('download');
    expect(fileNameFromUrl('nonsense')).toBe('download');
  });
});
