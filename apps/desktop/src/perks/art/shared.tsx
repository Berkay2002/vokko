// Shared pieces of Vokko's illustrated perks (decorations, nameplates, effect particles): gradient shorthands, sparkles, blossoms and
// leaves. All art is original inline SVG; animations are CSS classes from ./art.css (transform and opacity only, paused for reduced motion).
import type { CSSProperties, ReactElement } from "react";
import "./art.css";

/** One piece of art: `u` is a per-instance prefix for gradient / mask ids (many copies render on one page). */
export type Art = (u: string) => ReactElement;

/** `id("a")` names a def, `url("a")` references it. */
export const ids = (u: string) => [(k: string) => `${u}-${k}`, (k: string) => `url(#${u}-${k})`] as const;

const stops = (c: string[]) => c.map((color, i) => <stop key={i} offset={c.length === 1 ? 0 : i / (c.length - 1)} stopColor={color} />);

/** Linear gradient, top to bottom unless `h` (left to right). */
export const Lin = ({ id, c, h }: { id: string; c: string[]; h?: boolean }) => (
  <linearGradient id={id} x1="0" y1="0" x2={h ? 1 : 0} y2={h ? 0 : 1}>
    {stops(c)}
  </linearGradient>
);

/** Radial gradient lit from the upper left (or from `cx`/`cy`). */
export const Rad = ({ id, c, cx = 0.38, cy = 0.32, r = 0.75 }: { id: string; c: string[]; cx?: number; cy?: number; r?: number }) => (
  <radialGradient id={id} cx={cx} cy={cy} r={r}>
    {stops(c)}
  </radialGradient>
);

/** Soft glow: a colour fading to transparent. */
export const Glow = ({ id, color, opacity = 0.6 }: { id: string; color: string; opacity?: number }) => (
  <radialGradient id={id}>
    <stop offset="0" stopColor={color} stopOpacity={opacity} />
    <stop offset="1" stopColor={color} stopOpacity="0" />
  </radialGradient>
);

/** Animation delay / duration / origin for a `pk` element. */
export const anim = (delay = 0, duration?: number, origin?: string): CSSProperties => ({
  animationDelay: `${delay}s`,
  ...(duration ? { animationDuration: `${duration}s` } : {}),
  ...(origin ? { transformOrigin: origin } : {}),
});

/** A five-point star's polygon points around (0, 0). */
export const star5 = (r: number, inner = 0.48): string =>
  Array.from({ length: 10 }, (_, i) => {
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    const d = i % 2 ? r * inner : r;
    return `${(Math.cos(a) * d).toFixed(2)},${(Math.sin(a) * d).toFixed(2)}`;
  }).join(" ");

const SPARK = "M0 -1 C0.14 -0.14 0.14 -0.14 1 0 C0.14 0.14 0.14 0.14 0 1 C-0.14 0.14 -0.14 0.14 -1 0 C-0.14 -0.14 -0.14 -0.14 0 -1 Z";

/** A four-point twinkling sparkle of radius `r` at (x, y). */
export const Sparkle = ({ x, y, r, fill = "#fff", d = 0, still }: { x: number; y: number; r: number; fill?: string; d?: number; still?: boolean }) => (
  <g transform={`translate(${x} ${y}) scale(${r})`}>
    <path className={still ? undefined : "pk pk-twinkle"} style={still ? undefined : anim(d)} d={SPARK} fill={fill} />
  </g>
);

/** A cherry blossom petal, base at (0, 0), pointing up, about 7 units long. */
export const PETAL = "M0 0 C-3 -1.5 -3.4 -5.6 -1.1 -6.8 L0 -5.8 L1.1 -6.8 C3.4 -5.6 3 -1.5 0 0 Z";

/** A five-petal cherry blossom; `fill` is a gradient url or colour. */
export const Blossom = ({ x, y, s = 1, r = 0, fill, edge = "#d9668f" }: { x: number; y: number; s?: number; r?: number; fill: string; edge?: string }) => (
  <g transform={`translate(${x} ${y}) rotate(${r}) scale(${s})`}>
    {[0, 72, 144, 216, 288].map(a => (
      <path key={a} d={PETAL} transform={`rotate(${a})`} fill={fill} stroke={edge} strokeWidth="0.45" strokeLinejoin="round" />
    ))}
    <circle r="1.7" fill="#e0527f" />
    {[0, 60, 120, 180, 240, 300].map(a => (
      <circle key={a} cx={Math.cos((a * Math.PI) / 180) * 2.3} cy={Math.sin((a * Math.PI) / 180) * 2.3} r="0.5" fill="#ffd36b" />
    ))}
  </g>
);

/** A maple leaf around (0, 0), about 13 units across, stem down. */
export const MAPLE =
  "M0 -6.5 L1.4 -3.6 L2.8 -4.2 L2.4 -1.6 L5.8 -3 L4.6 -0.6 L5.6 0.2 L3 1.2 L4.2 2.6 L1.6 2.4 L0.6 3.2 L0 2.6 L-0.6 3.2 L-1.6 2.4 L-4.2 2.6 L-3 1.2 L-5.6 0.2 L-4.6 -0.6 L-5.8 -3 L-2.4 -1.6 L-2.8 -4.2 L-1.4 -3.6 Z";

export const Maple = ({ x, y, s = 1, r = 0, fill, edge }: { x: number; y: number; s?: number; r?: number; fill: string; edge: string }) => (
  <g transform={`translate(${x} ${y}) rotate(${r}) scale(${s})`}>
    <path d="M0 2.6 L0 6.2" stroke={edge} strokeWidth="0.8" strokeLinecap="round" />
    <path d={MAPLE} fill={fill} stroke={edge} strokeWidth="0.55" strokeLinejoin="round" />
    <path d="M0 2.4 L0 -4.6 M0 0.8 L4.2 -2.1 M0 0.8 L-4.2 -2.1 M0 1.5 L3 2.1 M0 1.5 L-3 2.1" stroke={edge} strokeWidth="0.35" strokeLinecap="round" opacity="0.7" />
  </g>
);

/** An oval leaf along +x from (0, 0), about 12 units long. */
export const LEAF = "M0 0 C3 -4.6 9 -5 12 0 C9 4.4 3 4.2 0 0 Z";

export const Leaf = ({ x, y, s = 1, r = 0, fill, edge }: { x: number; y: number; s?: number; r?: number; fill: string; edge: string }) => (
  <g transform={`translate(${x} ${y}) rotate(${r}) scale(${s})`}>
    <path d={LEAF} fill={fill} stroke={edge} strokeWidth="0.5" strokeLinejoin="round" />
    <path d="M0.8 0 Q6 -0.6 11 0" stroke={edge} strokeWidth="0.4" fill="none" opacity="0.7" />
  </g>
);
