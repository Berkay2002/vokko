// Profile frames (ids in perks/catalog.ts PROFILE_FRAMES): a drawn border around the whole profile card. Each frame is an edge tile
// repeated along all four sides (`t` px thick, the tile's y = 0 is the card's outer edge) and a corner drawn once at the top left with
// (0, 0) in the card's corner, mirrored into the other three. Sizes are px so the border stays thin at every card size and keeps to the
// card's padding; corners stay within about 56 px of the corner.
import type { ReactElement, ReactNode } from "react";
import { Blossom, Glow, Leaf, Lin, Maple, Rad, Sparkle, ids, star5 } from "./shared";
import "./scenes.css";

export interface FrameParts {
  /** Edge thickness in px. */
  t: number;
  /** Edge tile length in px. */
  w: number;
  tile: ReactNode;
  corner: ReactNode;
  defs?: ReactNode;
}

/** Mirror a corner half across the diagonal, so it runs along both edges. */
const both = (half: ReactNode) => (
  <>
    {half}
    <g transform="matrix(0 1 1 0 0 0)">{half}</g>
  </>
);

/** The frame drawing for a card of any size. */
export function FrameSvg({ parts, u }: { parts: FrameParts; u: string }): ReactElement {
  const [id, url] = ids(u);
  const { t, w, tile, corner, defs } = parts;
  const h = <rect width="100%" height={t} fill={url("h")} />;
  const v = <rect width={t} height="100%" fill={url("v")} />;
  const at = (x: string, y: string, transform: string, node: ReactNode) => (
    <svg x={x} y={y} overflow="visible">
      <g transform={transform}>{node}</g>
    </svg>
  );
  return (
    <svg width="100%" height="100%">
      <defs>
        {defs}
        <pattern id={id("h")} width={w} height={t} patternUnits="userSpaceOnUse">
          {tile}
        </pattern>
        <pattern id={id("v")} width={w} height={t} patternUnits="userSpaceOnUse" patternTransform="matrix(0 1 1 0 0 0)">
          {tile}
        </pattern>
      </defs>
      {h}
      {v}
      {at("0", "100%", "scale(1 -1)", h)}
      {at("100%", "0", "scale(-1 1)", v)}
      {corner}
      {at("100%", "0", "scale(-1 1)", corner)}
      {at("0", "100%", "scale(1 -1)", corner)}
      {at("100%", "100%", "scale(-1 -1)", corner)}
    </svg>
  );
}

type Frame = (u: string) => FrameParts;

const gardenVines: Frame = u => {
  const [id, url] = ids(u);
  return {
    t: 12,
    w: 36,
    defs: (
      <>
        <Rad id={id("rose")} c={["#fff4f8", "#ffb3cf", "#e86a9a"]} />
        <Rad id={id("lilac")} c={["#fbf4ff", "#d8b4ff", "#9b6fe0"]} />
      </>
    ),
    tile: (
      <>
        <path d="M0 6 C9 2.4 9 2.4 18 6 C27 9.6 27 9.6 36 6" stroke="#3d7a2c" strokeWidth="1.6" fill="none" />
        <Leaf x={8} y={4} s={0.42} r={-34} fill="#6cbf4a" edge="#2f6b26" />
        <Leaf x={26} y={8} s={0.42} r={34} fill="#86d15e" edge="#2f6b26" />
        <g transform="translate(18 6)">
          {[0, 72, 144, 216, 288].map(a => (
            <circle key={a} cx={Math.cos((a * Math.PI) / 180) * 1.3} cy={Math.sin((a * Math.PI) / 180) * 1.3} r="1.05" fill="#fff" stroke="#e7a3bd" strokeWidth="0.3" />
          ))}
          <circle r="0.7" fill="#ffd36b" />
        </g>
      </>
    ),
    corner: (
      <>
        {both(
          <>
            <path d="M5 4 C14 2 30 3 54 4" stroke="#2f6b26" strokeWidth="2.4" strokeLinecap="round" fill="none" />
            <Leaf x={20} y={4} s={0.72} r={-28} fill="#6cbf4a" edge="#2f6b26" />
            <Leaf x={34} y={4} s={0.6} r={22} fill="#86d15e" edge="#2f6b26" />
            <Leaf x={44} y={4} s={0.5} r={-30} fill="#6cbf4a" edge="#2f6b26" />
            <Blossom x={30} y={7} s={0.62} r={20} fill={url("lilac")} edge="#8a5ec8" />
          </>,
        )}
        <Leaf x={6} y={6} s={0.85} r={45} fill="#5aae3c" edge="#2f6b26" />
        <Blossom x={11} y={11} s={1.05} r={8} fill={url("rose")} />
        <Sparkle x={22} y={20} r={2.6} d={0.6} />
      </>
    ),
  };
};

const sakuraCorners: Frame = u => {
  const [id, url] = ids(u);
  const branch = (
    <>
      <path d="M2 3 C16 4 34 3 56 6" stroke="#4e2c20" strokeWidth="3.4" strokeLinecap="round" fill="none" />
      <path d="M2 3 C16 4 34 3 56 6" stroke="#8a5a44" strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M30 4 C34 9 36 12 40 13" stroke="#6b3f2c" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <Blossom x={24} y={5} s={0.8} r={12} fill={url("p")} />
      <Blossom x={42} y={13} s={0.6} r={50} fill={url("p")} />
      <path d="M54 6 C52 3.6 52 1 54 0 C56 1 56 3.6 54 6 Z" fill="#f48fb1" stroke="#c45883" strokeWidth="0.5" />
    </>
  );
  return {
    t: 6,
    w: 30,
    defs: <Rad id={id("p")} c={["#fff7fa", "#ffd0e0", "#f59bbb"]} />,
    tile: (
      <>
        <rect width="30" height="1.6" y="1.2" fill="#f7a8c4" />
        <path d="M0 4.4 H30" stroke="#ffd9e6" strokeWidth="0.8" strokeDasharray="1 3" />
        <path d="M15 4.6 C13.6 3.8 13.4 1.8 14.5 1.2 L15 1.7 L15.5 1.2 C16.6 1.8 16.4 3.8 15 4.6 Z" fill="#ffb6cf" stroke="#e57fa5" strokeWidth="0.3" />
      </>
    ),
    corner: (
      <>
        {both(branch)}
        <Blossom x={10} y={10} s={1.1} r={0} fill={url("p")} />
        <Sparkle x={20} y={20} r={2.4} d={1} />
      </>
    ),
  };
};

const AUTUMN: [string, string][] = [
  ["#e8452c", "#8a2a14"],
  ["#f39a2b", "#9a5212"],
  ["#f7c948", "#a07a14"],
];

const autumnTwigs: Frame = u => {
  const [id, url] = ids(u);
  return {
    t: 10,
    w: 34,
    defs: <Lin id={id("nut")} c={["#e0a868", "#b0703a"]} />,
    tile: (
      <>
        <path d="M0 4 C11 5.4 23 2.6 34 4" stroke="#6b3f2c" strokeWidth="1.3" fill="none" />
        <Maple x={9} y={5.4} s={0.4} r={160} fill={AUTUMN[0]![0]} edge={AUTUMN[0]![1]} />
        <Maple x={25} y={4.2} s={0.36} r={200} fill={AUTUMN[1]![0]} edge={AUTUMN[1]![1]} />
      </>
    ),
    corner: (
      <>
        {both(
          <>
            <path d="M4 4 C18 7 34 3 52 5" stroke="#5a3426" strokeWidth="2.4" strokeLinecap="round" fill="none" />
            <Maple x={26} y={9} s={0.9} r={170} fill={AUTUMN[1]![0]} edge={AUTUMN[1]![1]} />
            <Maple x={42} y={7} s={0.62} r={200} fill={AUTUMN[2]![0]} edge={AUTUMN[2]![1]} />
          </>,
        )}
        <Maple x={10} y={10} s={1.15} r={135} fill={AUTUMN[0]![0]} edge={AUTUMN[0]![1]} />
        <g transform="translate(22 20) rotate(-45)">
          <ellipse cy="3" rx="3.2" ry="4.2" fill={url("nut")} stroke="#7a4a24" strokeWidth="0.6" />
          <path d="M-3.8 0.4 C-3.8 -2.8 3.8 -2.8 3.8 0.4 C1.6 1.4 -1.6 1.4 -3.8 0.4 Z" fill="#8a5a34" stroke="#5a3426" strokeWidth="0.6" />
          <path d="M0 -2.2 L0 -4.4" stroke="#5a3426" strokeWidth="0.9" strokeLinecap="round" />
        </g>
      </>
    ),
  };
};

const rusticWood: Frame = u => {
  const [id, url] = ids(u);
  return {
    t: 11,
    w: 64,
    defs: (
      <>
        <Lin id={id("plank")} c={["#c4874f", "#a06a3a", "#7a4a24"]} />
        <Lin id={id("block")} c={["#8a5a34", "#5e3a1e"]} />
        <Lin id={id("rope")} c={["#e8cf98", "#c7a464"]} />
      </>
    ),
    tile: (
      <>
        <rect width="64" height="11" fill={url("plank")} />
        <rect width="64" height="1" y="10" fill="#4e2c16" opacity="0.6" />
        <path d="M0 3.2 C14 2 24 4.6 40 3.4 C50 2.6 58 3.6 64 3.2 M0 7 C10 8 22 6 34 7.4 C46 8.6 56 6.6 64 7" stroke="#6e4020" strokeWidth="0.6" fill="none" opacity="0.7" />
        <ellipse cx="44" cy="5.4" rx="3" ry="1.4" fill="none" stroke="#6e4020" strokeWidth="0.6" opacity="0.8" />
        <rect x="63" width="1" height="11" fill="#4e2c16" opacity="0.7" />
        <circle cx="4" cy="5.5" r="1.3" fill="#9aa0a8" stroke="#4a4e56" strokeWidth="0.5" />
      </>
    ),
    corner: (
      <>
        <rect x="0" y="0" width="22" height="22" rx="2" fill={url("block")} stroke="#3e2410" strokeWidth="1" />
        <path d="M3 8 C8 7 14 9 19 8 M3 15 C9 16 13 14 19 15" stroke="#3e2410" strokeWidth="0.6" fill="none" opacity="0.6" />
        <path d="M4 4 L18 18 M18 4 L4 18" stroke="#7a5a2a" strokeWidth="3.6" strokeLinecap="round" />
        <path d="M4 4 L18 18 M18 4 L4 18" stroke={url("rope")} strokeWidth="2.6" strokeLinecap="round" />
        <path d="M4 4 L18 18 M18 4 L4 18" stroke="#9a7a3a" strokeWidth="2.6" strokeDasharray="1 2" />
        {both(
          <>
            <path d="M26 14 C30 18 34 18 38 16" stroke="#3d7a2c" strokeWidth="1.1" fill="none" />
            <Leaf x={30} y={16} s={0.42} r={30} fill="#6cbf4a" edge="#2f6b26" />
            <Leaf x={35} y={16.4} s={0.36} r={-20} fill="#86d15e" edge="#2f6b26" />
          </>,
        )}
      </>
    ),
  };
};

const seaFoam: Frame = u => {
  const [id, url] = ids(u);
  return {
    t: 12,
    w: 24,
    defs: (
      <>
        <Lin id={id("sea")} c={["#1f6fb0", "#2fa3d6", "#5fd0e8"]} />
        <Rad id={id("shell")} c={["#fff5ec", "#ffc9b0", "#e88c78"]} cx={0.5} cy={0.9} r={0.9} />
      </>
    ),
    tile: (
      <>
        <path d="M0 0 H24 V7 C20 7 18 11 12 11 C6 11 4 7 0 7 Z" fill={url("sea")} />
        <path d="M0 7 C4 7 6 11 12 11 C18 11 20 7 24 7" stroke="#fff" strokeWidth="1.3" fill="none" opacity="0.9" />
        <circle cx="12" cy="7.6" r="0.8" fill="#fff" opacity="0.85" />
        <circle cx="4" cy="3.4" r="0.6" fill="#c8f2ff" opacity="0.8" />
      </>
    ),
    corner: (
      <>
        <g transform="translate(13 13) rotate(-45)">
          <path d="M0 9 L-10 -4 C-6 -11 6 -11 10 -4 Z" fill={url("shell")} stroke="#b8604c" strokeWidth="0.9" strokeLinejoin="round" />
          <path d="M0 9 L-6 -8 M0 9 L-2 -9.4 M0 9 L2 -9.4 M0 9 L6 -8" stroke="#b8604c" strokeWidth="0.7" />
          <path d="M-3 9 L3 9 L2 11 L-2 11 Z" fill="#e8a090" stroke="#b8604c" strokeWidth="0.6" />
        </g>
        {both(
          <g transform="translate(34 10) rotate(18)">
            <polygon points={star5(5.4, 0.45)} fill="#ff9a5c" stroke="#c4562a" strokeWidth="0.7" strokeLinejoin="round" />
            <circle r="0.7" cx="-1" cy="-1" fill="#ffd9b8" />
            <circle r="0.6" cx="1.4" cy="0.6" fill="#ffd9b8" />
          </g>,
        )}
        <circle cx="24" cy="24" r="2" fill="none" stroke="#c8f2ff" strokeWidth="0.8" />
        <circle cx="29" cy="20" r="1.2" fill="none" stroke="#c8f2ff" strokeWidth="0.7" />
      </>
    ),
  };
};

const iceCrystals: Frame = u => {
  const [id, url] = ids(u);
  const flake = (
    <g stroke="#e8fbff" strokeWidth="1.6" strokeLinecap="round" fill="none">
      {[0, 60, 120].map(a => (
        <path key={a} d="M0 -10 L0 10 M-3 -6.6 L0 -4 L3 -6.6 M-3 6.6 L0 4 L3 6.6" transform={`rotate(${a})`} />
      ))}
    </g>
  );
  return {
    t: 13,
    w: 20,
    defs: (
      <>
        <Lin id={id("band")} c={["#ffffff", "#c8efff", "#8fd3f5"]} />
        <Lin id={id("ice")} c={["#ffffff", "#bfeaff", "#7cc7ee"]} />
      </>
    ),
    tile: (
      <>
        <rect width="20" height="4.6" fill={url("band")} />
        <path d="M1 4.4 L3.6 11.4 L6.2 4.4 Z M7.4 4.4 L9 8.6 L10.6 4.4 Z M12 4.4 L14.6 12.6 L17.2 4.4 Z" fill={url("ice")} stroke="#5fb6e6" strokeWidth="0.5" strokeLinejoin="round" />
        <path d="M2.8 5.4 L3.6 8.4 M13.6 5.4 L14.4 9" stroke="#fff" strokeWidth="0.6" strokeLinecap="round" />
        <path d="M0 1.2 H20" stroke="#fff" strokeWidth="0.8" />
      </>
    ),
    corner: (
      <>
        {both(
          <>
            <path d="M18 2 L40 6 L22 9 Z" fill={url("ice")} stroke="#5fb6e6" strokeWidth="0.7" strokeLinejoin="round" />
            <path d="M30 3 L50 5 L34 7.6 Z" fill={url("ice")} stroke="#5fb6e6" strokeWidth="0.6" strokeLinejoin="round" />
          </>,
        )}
        <circle cx="12" cy="12" r="12" fill="#bfeaff" opacity="0.35" />
        <g transform="translate(12 12)">
          <g stroke="#5fb6e6" strokeWidth="3.4" strokeLinecap="round" fill="none">
            {[0, 60, 120].map(a => (
              <path key={a} d="M0 -10 L0 10" transform={`rotate(${a})`} />
            ))}
          </g>
          {flake}
          <circle r="1.8" fill="#fff" />
        </g>
        <Sparkle x={26} y={22} r={2.8} d={0.2} />
        <Sparkle x={6} y={30} r={1.8} d={1.4} />
      </>
    ),
  };
};

const flameBorder: Frame = u => {
  const [id, url] = ids(u);
  const tongue = (x: number, h: number) => (
    <g transform={`translate(${x} 0)`}>
      <path d={`M-3.6 0 C-3.8 ${h * 0.5} -1.4 ${h * 0.7} 0 ${h} C1.4 ${h * 0.7} 3.8 ${h * 0.5} 3.6 0 Z`} fill={url("fl")} />
      <path d={`M-1.8 0 C-1.8 ${h * 0.4} -0.6 ${h * 0.55} 0 ${h * 0.7} C0.6 ${h * 0.55} 1.8 ${h * 0.4} 1.8 0 Z`} fill="#fff1a8" />
    </g>
  );
  const big = (
    <>
      <path d="M0 0 C2 10 10 16 12 26 C14 18 12 12 16 6 C17 14 22 18 22 26 C28 18 26 8 20 0 Z" fill={url("big")} stroke="#a82a10" strokeWidth="0.8" strokeLinejoin="round" />
      <path d="M4 0 C6 8 11 12 12 18 C13.6 12 13 8 15.6 4 C16.6 9 19 12 19 16 C22 10 20 5 17 0 Z" fill="#ffd34d" />
      <path d="M8 0 C9 4 11.4 7 12 10 C13 7 13.4 4 13 0 Z" fill="#fff6c8" />
    </>
  );
  return {
    t: 14,
    w: 16,
    defs: (
      <>
        <Lin id={id("fl")} c={["#ff3d1e", "#ff8a1e", "#ffc23d"]} />
        <Lin id={id("big")} c={["#ff2d14", "#ff7a1e", "#ffb02e"]} />
        <Glow id={id("glow")} color="#ff8a1e" opacity={0.65} />
      </>
    ),
    tile: (
      <>
        <rect width="16" height="3" fill="#b8260e" />
        {tongue(4, 11)}
        {tongue(12, 7.4)}
      </>
    ),
    corner: (
      <>
        <circle r="34" fill={url("glow")} className="pk pk-flicker" />
        {both(<g transform="translate(20 0)">{big}</g>)}
        <g className="pk pk-flicker" style={{ animationDuration: "1.3s" }}>
          <g transform="rotate(-45) translate(-12 0) scale(1.15)">{big}</g>
        </g>
        <circle cx="30" cy="22" r="1.1" fill="#ffd34d" className="pk pk-rise" />
        <circle cx="20" cy="32" r="0.9" fill="#ffb02e" className="pk pk-rise" style={{ animationDelay: "1.2s" }} />
      </>
    ),
  };
};

const cosmicStars: Frame = u => {
  const [id, url] = ids(u);
  return {
    t: 11,
    w: 40,
    defs: (
      <>
        <Lin id={id("night")} c={["#0e0a2e", "#241a5c"]} />
        <Lin id={id("gold")} c={["#fff1b8", "#e8b84a"]} />
        <Rad id={id("moon")} c={["#fffbe6", "#ffe39a", "#e8b450"]} />
        <Rad id={id("planet")} c={["#c4f0ff", "#6fa8ff", "#5a3ab8"]} />
        <Glow id={id("glow")} color="#b48bff" opacity={0.55} />
      </>
    ),
    tile: (
      <>
        <rect width="40" height="9" fill={url("night")} />
        <rect width="40" height="0.9" y="9.4" fill={url("gold")} />
        {[
          [4, 3, 0.7], [11, 6.4, 0.5], [17, 2.4, 0.9], [24, 5.4, 0.6], [31, 3.2, 0.5], [36, 6.6, 0.8],
        ].map(([x, y, r], i) => (
          <circle key={i} cx={x} cy={y} r={r} fill={i % 2 ? "#cfd8ff" : "#fff"} />
        ))}
        <polygon points={star5(1.8)} transform="translate(28 4.6)" fill="#ffe39a" />
      </>
    ),
    corner: (
      <>
        <circle cx="12" cy="12" r="26" fill={url("glow")} />
        <path d="M22 12 A11 11 0 1 1 12 1 A8.4 8.4 0 1 0 22 12 Z" transform="rotate(20 12 12)" fill={url("moon")} stroke="#c88a2a" strokeWidth="0.8" />
        {both(
          <g transform="translate(36 6)">
            <circle r="3.8" fill={url("planet")} stroke="#3a2a80" strokeWidth="0.5" />
            <ellipse rx="7" ry="1.6" transform="rotate(-18)" fill="none" stroke="#ffe39a" strokeWidth="0.9" />
          </g>,
        )}
        <Sparkle x={24} y={24} r={3.4} fill="#fff6c8" d={0.4} />
        <Sparkle x={8} y={34} r={2} d={1.4} />
        <Sparkle x={34} y={16} r={1.8} d={2.2} />
      </>
    ),
  };
};

const goldFiligree: Frame = u => {
  const [id, url] = ids(u);
  const curl = (
    <>
      <path d="M17 7 C24 1 33 2 37 7 C39.4 10 36.6 13.4 33.6 11.6 C31.4 10.2 32.6 7.6 34.6 8.6" stroke={url("g")} strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <path d="M40 4 C46 1 52 2 56 5" stroke={url("g")} strokeWidth="1.3" fill="none" strokeLinecap="round" />
      <path d="M24 10 C27 14 31 15 34 15" stroke={url("g")} strokeWidth="1.1" fill="none" strokeLinecap="round" />
      <path d="M44 4.2 C45 7 47.4 8 49 7.4 C48.4 5.6 46.6 4.4 44 4.2 Z" fill={url("g")} stroke="#8a5a14" strokeWidth="0.4" />
      <circle cx="56.6" cy="5.2" r="1.3" fill={url("g")} stroke="#8a5a14" strokeWidth="0.4" />
    </>
  );
  return {
    t: 10,
    w: 24,
    defs: (
      <>
        <Lin id={id("g")} c={["#fff3c4", "#f0c45a", "#b07a1e"]} />
        <Rad id={id("ruby")} c={["#ffb0c0", "#e0244e", "#7a0a24"]} />
        <Rad id={id("plate")} c={["#fff6d0", "#e8b84a", "#9a6614"]} />
      </>
    ),
    tile: (
      <>
        <rect width="24" height="1.8" y="0.6" fill={url("g")} />
        <rect width="24" height="0.8" y="7.8" fill={url("g")} />
        <path
          d="M0 4.8 C3 2.4 6 2.4 8 4.4 C9.4 5.8 8 7 6.8 6.2 C5.8 5.4 6.6 4.2 7.6 4.6 M24 4.8 C21 2.4 18 2.4 16 4.4 C14.6 5.8 16 7 17.2 6.2 C18.2 5.4 17.4 4.2 16.4 4.6 M8 4.4 Q12 3.2 16 4.4"
          stroke="#e0aa3c"
          strokeWidth="0.8"
          fill="none"
        />
        <path d="M12 3 L13.4 4.6 L12 6.2 L10.6 4.6 Z" fill={url("g")} stroke="#8a5a14" strokeWidth="0.3" />
      </>
    ),
    corner: (
      <>
        {both(curl)}
        <path d="M0 0 H22 C22 6 16 10 12 12 C10 16 6 22 0 22 Z" fill={url("plate")} stroke="#8a5a14" strokeWidth="0.8" />
        <circle cx="10" cy="10" r="6.4" fill={url("g")} stroke="#8a5a14" strokeWidth="0.7" />
        <circle cx="10" cy="10" r="4.4" fill={url("ruby")} stroke="#5a0a1a" strokeWidth="0.5" />
        <ellipse cx="8.6" cy="8.4" rx="1.6" ry="1" fill="#fff" opacity="0.8" />
        <Sparkle x={13} y={7} r={2.4} d={0.5} />
        <Sparkle x={26} y={26} r={1.8} fill="#fff3c4" d={1.6} />
      </>
    ),
  };
};

const neonGlow: Frame = u => {
  const [id, url] = ids(u);
  return {
    t: 9,
    w: 10,
    defs: <Glow id={id("glow")} color="#ff4fd8" opacity={0.6} />,
    tile: (
      <>
        <rect width="10" height="4.4" y="1.4" fill="#ff3fd1" opacity="0.22" />
        <rect width="10" height="1.4" y="2.9" fill="#ff8be9" />
        <rect width="10" height="0.5" y="3.35" fill="#fff" opacity="0.8" />
        <rect width="10" height="2.6" y="5.6" fill="#29d9ff" opacity="0.18" />
        <rect width="10" height="0.8" y="6.5" fill="#6ff0ff" />
      </>
    ),
    corner: (
      <>
        <circle cx="14" cy="14" r="22" fill={url("glow")} className="pk pk-pulse" />
        <g className="pk pk-pulse" style={{ animationDuration: "1.8s" }}>
          <path d="M4 26 V12 A8 8 0 0 1 12 4 H26" stroke="#ff3fd1" strokeWidth="5" fill="none" opacity="0.3" strokeLinecap="round" />
          <path d="M4 26 V12 A8 8 0 0 1 12 4 H26" stroke="#ff8be9" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          <g transform="translate(17 17) rotate(-10)">
            <polygon points={star5(7)} fill="none" stroke="#29d9ff" strokeWidth="3.4" strokeLinejoin="round" opacity="0.3" />
            <polygon points={star5(7)} fill="none" stroke="#9ff6ff" strokeWidth="1.2" strokeLinejoin="round" />
          </g>
        </g>
      </>
    ),
  };
};

const pixelBorder: Frame = () => {
  const px = (cells: [number, number, string][], s: number) => cells.map(([x, y, c], i) => <rect key={i} x={x * s} y={y * s} width={s} height={s} fill={c} />);
  // a 9 x 9 sparkle star, cell size 3
  const D = "#2b1d66", Y = "#ffe14d", W = "#ffffff", P = "#7b5cff";
  const star: [number, number, string][] = [
    [4, 0, D], [3, 1, D], [4, 1, Y], [5, 1, D], [3, 2, D], [4, 2, W], [5, 2, D],
    [0, 4, D], [1, 3, D], [2, 3, D], [1, 4, Y], [2, 4, Y], [1, 5, D], [2, 5, D],
    [8, 4, D], [6, 3, D], [7, 3, D], [6, 4, Y], [7, 4, Y], [6, 5, D], [7, 5, D],
    [3, 3, Y], [4, 3, W], [5, 3, Y], [3, 4, W], [4, 4, W], [5, 4, Y], [3, 5, Y], [4, 5, Y], [5, 5, Y],
    [3, 6, D], [4, 6, Y], [5, 6, D], [3, 7, D], [4, 7, Y], [5, 7, D], [4, 8, D],
  ];
  return {
    t: 8,
    w: 8,
    tile: (
      <g shapeRendering="crispEdges">
        <rect width="4" height="4" fill="#7b5cff" />
        <rect x="4" width="4" height="4" fill="#45d0ff" />
        <rect y="4" width="4" height="4" fill="#2b1d66" />
        <rect x="4" y="4" width="4" height="4" fill="#7b5cff" opacity="0.7" />
      </g>
    ),
    corner: (
      <g shapeRendering="crispEdges">
        <rect width="16" height="16" fill="#2b1d66" />
        <rect x="4" y="4" width="8" height="8" fill="#ff4f8b" />
        <rect x="4" y="4" width="4" height="4" fill="#ffd1e0" />
        {both(px([[5, 0, P], [6, 0, P], [5, 1, D], [8, 0, "#45d0ff"]], 4))}
        <g transform="translate(13 13)" className="pk pk-twinkle" style={{ animationDuration: "1.6s" }}>
          {px(star, 3)}
        </g>
      </g>
    ),
  };
};

const candyCane: Frame = u => {
  const [id, url] = ids(u);
  const stripe = (x: number) => <path d={`M${x} 0 H${x + 4} L${x + 1} 9 H${x - 3} Z`} fill="#e8243c" />;
  return {
    t: 9,
    w: 12,
    defs: (
      <>
        <Lin id={id("cane")} c={["#ffffff", "#f3eef2"]} />
        <Rad id={id("gum1")} c={["#d8ffd0", "#57d28f", "#2a8a50"]} />
        <Rad id={id("gum2")} c={["#e8dcff", "#b57cff", "#6a3ab8"]} />
      </>
    ),
    tile: (
      <>
        <rect width="12" height="9" fill={url("cane")} />
        {stripe(2)}
        {stripe(8)}
        {stripe(14)}
        <rect width="12" height="1.2" y="1.4" fill="#fff" opacity="0.7" />
        <rect width="12" height="0.8" y="8.2" fill="#b8a8b8" opacity="0.6" />
      </>
    ),
    corner: (
      <>
        <g transform="translate(14 14)">
          <path d="M6 6 L18 18" stroke="#d8c8a8" strokeWidth="3" strokeLinecap="round" />
          <circle r="11.5" fill="#fff" stroke="#c8243c" strokeWidth="0.9" />
          {[0, 1, 2, 3].map(i => (
            <path key={i} d="M0 0 C3 -4 8 -4 10.6 -1 C8.4 -6 3 -8 -1 -5 Z" transform={`rotate(${i * 90})`} fill={i % 2 ? "#ff5f9a" : "#e8243c"} />
          ))}
          <circle r="2.2" fill="#fff" />
          <ellipse cx="-4.6" cy="-5.6" rx="3" ry="1.6" transform="rotate(-35 -4.6 -5.6)" fill="#fff" opacity="0.7" />
        </g>
        {both(
          <>
            <path d="M34 9 C34 4 42 4 42 9 Z" fill={url("gum1")} stroke="#2a8a50" strokeWidth="0.6" />
            <circle cx="36.6" cy="6.4" r="0.7" fill="#fff" opacity="0.8" />
            <path d="M46 8 C46 4 52 4 52 8 Z" fill={url("gum2")} stroke="#6a3ab8" strokeWidth="0.6" />
          </>,
        )}
        <Sparkle x={28} y={26} r={2.2} d={0.8} />
      </>
    ),
  };
};

/** Every frame, by frame id. */
export const FRAME_ART: Record<string, Frame> = {
  "garden-vines": gardenVines,
  "sakura-corners": sakuraCorners,
  "autumn-twigs": autumnTwigs,
  "rustic-wood": rusticWood,
  "sea-foam": seaFoam,
  "ice-crystals": iceCrystals,
  "flame-border": flameBorder,
  "cosmic-stars": cosmicStars,
  "gold-filigree": goldFiligree,
  "neon-glow": neonGlow,
  "pixel-border": pixelBorder,
  "candy-cane": candyCane,
};
