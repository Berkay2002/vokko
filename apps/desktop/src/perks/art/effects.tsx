// Drawn particles of the illustrated profile effects (perks/catalog.ts PROFILE_EFFECTS). Each fills its particle box and takes its
// colour from `currentColor` (the particle's --pe-color), so one drawing serves every colour; shading is white and black overlays.
import type { ReactElement } from "react";
import { MAPLE, PETAL, anim, star5 } from "./shared";

const shade = "rgb(0 0 0 / 0.28)";

export const EFFECT_SHAPES: Record<string, ReactElement> = {
  leaf: (
    <svg viewBox="-8 -8 16 16">
      <path d="M0 2.6 L0 6.6" stroke={shade} strokeWidth="0.9" strokeLinecap="round" />
      <path d={MAPLE} fill="currentColor" stroke={shade} strokeWidth="0.5" strokeLinejoin="round" />
      <path d="M0 2.4 L0 -4.6 M0 0.8 L4.2 -2.1 M0 0.8 L-4.2 -2.1" stroke={shade} strokeWidth="0.4" strokeLinecap="round" />
      <path d="M-1.4 -3.4 L-2.6 -1.8" stroke="#fff" strokeWidth="0.6" opacity="0.5" strokeLinecap="round" />
    </svg>
  ),
  heart: (
    <svg viewBox="0 0 24 24">
      <path d="M12 21 C5 15.5 2 12 2 8 C2 5 4.5 3 7.2 3 C9.2 3 11 4.2 12 6 C13 4.2 14.8 3 16.8 3 C19.5 3 22 5 22 8 C22 12 19 15.5 12 21 Z" fill="currentColor" stroke={shade} strokeWidth="0.8" />
      <path d="M12 21 C17 17 20.6 13.4 21.6 10 C19 14 16 16.6 12 18.4 Z" fill={shade} opacity="0.6" />
      <ellipse cx="7.4" cy="7.6" rx="2.4" ry="1.6" transform="rotate(-35 7.4 7.6)" fill="#fff" opacity="0.7" />
    </svg>
  ),
  "shooting-star": (
    <svg viewBox="0 0 72 24">
      <path d="M0 12 L58 8.4 L58 15.6 Z" fill="currentColor" opacity="0.12" />
      <path d="M22 12 L58 9.6 L58 14.4 Z" fill="currentColor" opacity="0.22" />
      <path d="M42 12 L58 10.6 L58 13.4 Z" fill="#fff" opacity="0.5" />
      <g transform="translate(60 12)">
        <polygon points={star5(9)} fill="currentColor" stroke={shade} strokeWidth="0.6" strokeLinejoin="round" />
        <circle r="2.6" fill="#fff" opacity="0.85" />
      </g>
    </svg>
  ),
  blossom: (
    <svg viewBox="-8 -8 16 16">
      {[0, 72, 144, 216, 288].map(a => (
        <path key={a} d={PETAL} transform={`rotate(${a})`} fill="currentColor" stroke={shade} strokeWidth="0.35" strokeLinejoin="round" />
      ))}
      {[0, 72, 144, 216, 288].map(a => (
        <path key={a} d="M0 -1.6 L0 -4.4" transform={`rotate(${a})`} stroke="#fff" strokeWidth="0.6" opacity="0.55" strokeLinecap="round" />
      ))}
      <circle r="1.6" fill="#e0527f" />
      <circle r="0.7" fill="#ffd36b" />
    </svg>
  ),
  butterfly: (
    <svg viewBox="-12 -10 24 20">
      <g className="pk pk-flap" style={anim(0, 0.42, "100% 50%")}>
        <path d="M-0.6 -1 C-4 -9 -11 -10 -11 -4.6 C-11 -1 -6 0 -0.6 -0.2 Z" fill="currentColor" stroke={shade} strokeWidth="0.5" />
        <path d="M-0.6 0.4 C-5 1 -9 3 -8 6.6 C-6.6 9 -2.6 6 -0.6 1.4 Z" fill="currentColor" stroke={shade} strokeWidth="0.5" />
        <circle cx="-6.6" cy="-4.6" r="1.6" fill="#fff" opacity="0.75" />
        <circle cx="-4.6" cy="3.6" r="1" fill="#fff" opacity="0.6" />
      </g>
      <g className="pk pk-flap" style={anim(0, 0.42, "0% 50%")}>
        <path d="M0.6 -1 C4 -9 11 -10 11 -4.6 C11 -1 6 0 0.6 -0.2 Z" fill="currentColor" stroke={shade} strokeWidth="0.5" />
        <path d="M0.6 0.4 C5 1 9 3 8 6.6 C6.6 9 2.6 6 0.6 1.4 Z" fill="currentColor" stroke={shade} strokeWidth="0.5" />
        <circle cx="6.6" cy="-4.6" r="1.6" fill="#fff" opacity="0.75" />
        <circle cx="4.6" cy="3.6" r="1" fill="#fff" opacity="0.6" />
      </g>
      <ellipse rx="1" ry="5" fill="#2a2030" />
      <path d="M-0.4 -4.6 Q-2 -8 -3.4 -8.6 M0.4 -4.6 Q2 -8 3.4 -8.6" stroke="#2a2030" strokeWidth="0.5" fill="none" strokeLinecap="round" />
    </svg>
  ),
  bubble: (
    <svg viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10.5" fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="1.1" />
      <path d="M5.6 9 A7.4 7.4 0 0 1 10.4 4.6" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" opacity="0.9" />
      <circle cx="16.4" cy="17" r="1.2" fill="#fff" opacity="0.7" />
      <path d="M18.6 8 A8 8 0 0 1 19.6 12.6" stroke="#ff9ce0" strokeWidth="0.9" fill="none" strokeLinecap="round" opacity="0.7" />
    </svg>
  ),
};
