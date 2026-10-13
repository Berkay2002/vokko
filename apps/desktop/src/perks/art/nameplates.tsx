// Illustrated nameplates (ids in perks/catalog.ts NAMEPLATES with `art: true`). Each scene draws in a 132 x 44 box that is pinned to
// the right end of the row; its left part fades into the plate's background (CSS mask), so the subject sits in the right third.
import { Blossom, Glow, Lin, MAPLE, Rad, Sparkle, anim, ids, type Art } from "./shared";

const robin: Art = u => {
  const [id, url] = ids(u);
  return (
    <>
      <defs>
        <Lin id={id("sky")} c={["#4c7a62", "#82b48f"]} />
        <Glow id={id("sun")} color="#f4ffd8" opacity={0.55} />
        <Lin id={id("back")} c={["#9a6444", "#5e3a24"]} />
        <Rad id={id("breast")} c={["#ffb07a", "#f2683a", "#cc4420"]} />
        <Lin id={id("br")} c={["#7a5038", "#4a2e1e"]} />
        <Lin id={id("lf")} c={["#9be27a", "#3f8f45"]} />
      </defs>
      <rect width="132" height="44" fill={url("sky")} />
      <circle cx="112" cy="8" r="26" fill={url("sun")} />
      <circle cx="74" cy="10" r="6" fill="#fff" opacity="0.08" />
      <circle cx="88" cy="36" r="4" fill="#fff" opacity="0.08" />
      <circle cx="126" cy="30" r="5" fill="#fff" opacity="0.07" />
      <path d="M134 33 C118 31 104 33 90 36 C82 38 74 37 64 41" stroke={url("br")} strokeWidth="2.8" strokeLinecap="round" fill="none" />
      <path d="M108 32.6 C112 27 116 25 122 23.5" stroke={url("br")} strokeWidth="1.4" strokeLinecap="round" fill="none" />
      {[
        [122, 23.5, -30],
        [116, 26.5, -100],
        [80, 38, 160],
        [126, 33, 20],
      ].map(([x, y, r]) => (
        <path key={x} d="M0 0 C2.5 -3.6 7.5 -4 10 0 C7.5 3.6 2.5 3.4 0 0 Z" transform={`translate(${x} ${y}) rotate(${r})`} fill={url("lf")} stroke="#2e6f34" strokeWidth="0.5" />
      ))}
      {[
        [86, 39.5],
        [89, 40.6],
        [87.2, 42],
      ].map(([x, y]) => (
        <g key={x}>
          <circle cx={x} cy={y} r="1.6" fill="#e0303a" />
          <circle cx={x - 0.5} cy={y - 0.5} r="0.45" fill="#fff" opacity="0.8" />
        </g>
      ))}
      <g transform="translate(100 21)">
        <g className="pk pk-bob" style={anim(0, 2.6)}>
          <path d="M-2 9 L-2 12.4 M2 9 L2 12.6" stroke="#6b4a2a" strokeWidth="0.8" strokeLinecap="round" />
          <path d="M-8 2 L-17 -1.5 L-16 4.5 Z" fill={url("back")} stroke="#3e2414" strokeWidth="0.6" strokeLinejoin="round" />
          <ellipse cx="0" cy="0" rx="10" ry="8.6" fill={url("back")} stroke="#3e2414" strokeWidth="0.7" />
          <ellipse cx="3.6" cy="2.2" rx="6.6" ry="6.2" fill={url("breast")} />
          <ellipse cx="2" cy="7" rx="4" ry="1.8" fill="#fff3e6" />
          <path d="M-7 -2.6 C-2 -6 4 -2.6 3.2 3 C-0.6 5 -6 3.4 -9.4 1 Z" fill="#6e4429" stroke="#3e2414" strokeWidth="0.6" />
          <path d="M-6 -0.6 Q-2 -2.4 1.8 0.4 M-6.4 1.6 Q-3 0.4 0.4 2.8" stroke="#a87650" strokeWidth="0.5" fill="none" />
          <circle cx="6" cy="-6" r="5.6" fill={url("back")} stroke="#3e2414" strokeWidth="0.6" />
          <circle cx="8.2" cy="-4" r="3.6" fill={url("breast")} />
          <circle cx="8" cy="-7.2" r="1.3" fill="#1a1010" />
          <circle cx="8.4" cy="-7.6" r="0.45" fill="#fff" />
          <path d="M11.2 -6.4 L14.6 -5.3 L11.2 -4.2 Z" fill="#f2b13a" stroke="#a0700f" strokeWidth="0.4" strokeLinejoin="round" />
          <path d="M2.4 -10.4 Q5 -12 8.4 -11" stroke="#fff" strokeWidth="0.6" opacity="0.5" fill="none" strokeLinecap="round" />
        </g>
      </g>
      <Sparkle x={72} y={22} r={1.6} fill="#f6ffe0" d={0.4} />
      <Sparkle x={124} y={12} r={1.4} fill="#f6ffe0" d={1.3} />
    </>
  );
};

const berryMouse: Art = u => {
  const [id, url] = ids(u);
  const berry = (x: number, y: number, s = 1) => (
    <g key={`${x}${y}`} transform={`translate(${x} ${y}) scale(${s})`}>
      {[
        [0, 0],
        [-1.7, 1.2],
        [1.7, 1.2],
        [0, 2.4],
        [-0.9, -1.4],
        [0.9, -1.4],
      ].map(([bx, by]) => (
        <circle key={`${bx}${by}`} cx={bx} cy={by} r="1.25" fill={url("berry")} stroke="#7a0f22" strokeWidth="0.3" />
      ))}
      <path d="M-1.4 -2.6 L0 -2 L1.4 -2.6 L0.6 -3.4 Z" fill="#4c9a3a" />
    </g>
  );
  return (
    <>
      <defs>
        <Lin id={id("bg")} c={["#4a3048", "#6e4058"]} />
        <Glow id={id("warm")} color="#ffb48a" opacity={0.4} />
        <Rad id={id("fur")} c={["#f2c48a", "#d6904f", "#a8622f"]} />
        <Rad id={id("berry")} c={["#ff8a9a", "#e0284a", "#9a1028"]} />
        <Lin id={id("lf")} c={["#8fd46a", "#3f8a3f"]} />
      </defs>
      <rect width="132" height="44" fill={url("bg")} />
      <circle cx="102" cy="26" r="26" fill={url("warm")} />
      <path d="M76 44 C80 30 84 20 86 8 M122 44 C120 32 122 20 126 6 M108 44 C110 38 112 34 116 30" stroke="#4f8a3a" strokeWidth="1" fill="none" strokeLinecap="round" />
      {[
        [86, 10, -40],
        [80, 24, 200],
        [120, 22, -150],
        [126, 9, -60],
        [114, 31, -20],
      ].map(([x, y, r]) => (
        <path key={`${x}${y}`} d="M0 0 C2.5 -3.4 7 -3.8 9.4 0 C7 3.4 2.5 3.2 0 0 Z" transform={`translate(${x} ${y}) rotate(${r})`} fill={url("lf")} stroke="#2e6f34" strokeWidth="0.45" />
      ))}
      {berry(87, 13, 1.1)}
      {berry(78, 30)}
      {berry(125, 13, 1.1)}
      {berry(121, 26, 0.9)}
      <path d="M60 44 Q80 36 100 40 Q118 36 134 40 L134 44 Z" fill="#2e4a2c" />
      <g transform="translate(101 32)">
        <g className="pk pk-sway" style={anim(0, 3.4, "100% 50%")}>
          <path d="M-8 2 C-16 6 -20 -2 -15 -4 C-12 -5 -11 -2 -13 -1" stroke="#e8a0a0" strokeWidth="0.9" fill="none" strokeLinecap="round" />
        </g>
        <ellipse cx="0" cy="0" rx="9" ry="7" fill={url("fur")} stroke="#7a4420" strokeWidth="0.6" />
        <ellipse cx="2" cy="3" rx="5" ry="3.4" fill="#fff1dc" />
        <circle cx="4" cy="-9.4" r="4.2" fill={url("fur")} stroke="#7a4420" strokeWidth="0.6" />
        <circle cx="4" cy="-9.4" r="2.6" fill="#ffb4c0" />
        <circle cx="7" cy="-5" r="5.6" fill={url("fur")} stroke="#7a4420" strokeWidth="0.6" />
        <ellipse cx="11.6" cy="-3.6" rx="2.6" ry="2" fill={url("fur")} />
        <circle cx="13.8" cy="-3.6" r="1.1" fill="#ff8aa0" />
        <circle cx="9" cy="-6.4" r="1.15" fill="#1a1010" />
        <circle cx="9.4" cy="-6.8" r="0.4" fill="#fff" />
        <path d="M13 -2.8 L17 -1.6 M13 -3.4 L17.4 -3.8 M12.6 -2.4 L16 -0.2" stroke="#fff" strokeWidth="0.3" opacity="0.8" />
        <ellipse cx="6.8" cy="-2.6" rx="1.1" ry="0.7" fill="#ff9aaa" opacity="0.7" />
        {berry(10.6, 2.2, 0.9)}
        <ellipse cx="8.6" cy="3.6" rx="1.6" ry="1" fill="#ffc8c8" />
        <ellipse cx="12.4" cy="3.4" rx="1.6" ry="1" fill="#ffc8c8" />
        <path d="M-5 -4 Q0 -7.2 4 -6" stroke="#fff" strokeWidth="0.6" opacity="0.45" fill="none" strokeLinecap="round" />
      </g>
      <Sparkle x={70} y={14} r={1.4} fill="#ffe6ee" d={0.3} />
      <Sparkle x={131} y={36} r={1.2} fill="#ffe6ee" d={1.2} />
    </>
  );
};

const KOI_BODY = "M-10 0 C-6 -4.6 4 -5 9 -1.6 C10.6 0 10.6 1 9 1.8 C4 5 -6 4.6 -10 0 Z";

const koiPond: Art = u => {
  const [id, url] = ids(u);
  const koi = (x: number, y: number, r: number, d: number, spots: string) => (
    <g transform={`translate(${x} ${y}) rotate(${r})`}>
      <g className="pk pk-swim" style={anim(d, 3.6)}>
        <path d="M-9 0 L-15.5 -4.2 Q-13.4 0 -15.5 4.2 Z" fill={spots} opacity="0.9" />
        <ellipse cx="-1" cy="-4" rx="3" ry="1.4" transform="rotate(-30 -1 -4)" fill="#fff" opacity="0.8" />
        <ellipse cx="-1" cy="4" rx="3" ry="1.4" transform="rotate(30 -1 4)" fill="#fff" opacity="0.8" />
        <path d={KOI_BODY} fill="#fffaf2" stroke="#c7b8a8" strokeWidth="0.4" />
        <ellipse cx="3" cy="-1" rx="4" ry="2.4" fill={spots} />
        <ellipse cx="-5" cy="0.8" rx="2.6" ry="1.8" fill={spots} />
        <circle cx="7.4" cy="-1" r="0.6" fill="#222" />
        <path d="M-6 -2.4 Q0 -4.4 6 -2.6" stroke="#fff" strokeWidth="0.6" opacity="0.8" fill="none" />
      </g>
    </g>
  );
  const pad = (x: number, y: number, r: number, rot: number) => (
    <g transform={`translate(${x} ${y}) rotate(${rot})`}>
      <path d={`M0 0 L${r} -1.4 A${r} ${r} 0 1 1 ${r} 1.4 Z`} fill={url("pad")} stroke="#24602f" strokeWidth="0.5" />
      <path d={`M0 0 L${-r * 0.8} ${-r * 0.4} M0 0 L${-r * 0.8} ${r * 0.4} M0 0 L0 ${-r * 0.85} M0 0 L0 ${r * 0.85}`} stroke="#9ce08a" strokeWidth="0.35" opacity="0.6" />
    </g>
  );
  return (
    <>
      <defs>
        <Rad id={id("water")} c={["#2a8a92", "#1a5e6c", "#123a4a"]} cx={0.75} cy={0.5} r={0.8} />
        <Rad id={id("pad")} c={["#9be08a", "#4fa04a", "#2f7a3a"]} />
        <Rad id={id("lotus")} c={["#ffffff", "#ffc6dc", "#f27aa8"]} cx={0.5} cy={0.9} />
      </defs>
      <rect width="132" height="44" fill={url("water")} />
      {[
        [84, 12, 0],
        [118, 36, 1.4],
      ].map(([x, y, d]) => (
        <g key={x} transform={`translate(${x} ${y})`}>
          <ellipse className="pk pk-pulse" style={anim(d, 3)} rx="7" ry="2.4" fill="none" stroke="#bff3f3" strokeWidth="0.5" />
          <ellipse className="pk pk-pulse" style={anim(d + 0.6, 3)} rx="11" ry="3.8" fill="none" stroke="#bff3f3" strokeWidth="0.4" opacity="0.6" />
        </g>
      ))}
      {koi(96, 18, -12, 0, "#ff7a2e")}
      {koi(112, 30, 168, 1.2, "#e8322e")}
      {pad(124, 11, 8, 30)}
      {pad(78, 33, 6, 200)}
      {pad(106, 40, 5, 120)}
      <g transform="translate(124 9)">
        {[-60, -30, 0, 30, 60].map(a => (
          <ellipse key={a} cx="0" cy="-3.6" rx="1.8" ry="3.8" transform={`rotate(${a})`} fill={url("lotus")} stroke="#d0608e" strokeWidth="0.4" />
        ))}
        <circle cx="0" cy="-0.6" r="1.4" fill="#ffd84a" />
      </g>
      <Sparkle x={68} y={22} r={1.4} fill="#dffcff" d={0.2} />
      <Sparkle x={100} y={6} r={1.2} fill="#dffcff" d={1.5} />
    </>
  );
};

const sleepyFox: Art = u => {
  const [id, url] = ids(u);
  return (
    <>
      <defs>
        <Lin id={id("sky")} c={["#3e2a3a", "#7a4038"]} />
        <Glow id={id("sun")} color="#ffb070" opacity={0.5} />
        <Rad id={id("fur")} c={["#ffb066", "#f07a2a", "#b84e16"]} />
        <Lin id={id("moss")} c={["#5a7a3a", "#2e4422"]} />
      </defs>
      <rect width="132" height="44" fill={url("sky")} />
      <circle cx="104" cy="40" r="30" fill={url("sun")} />
      <path d="M62 44 Q78 36 98 37 Q118 35 134 38 L134 44 Z" fill={url("moss")} />
      <g transform="translate(101 30)">
        <g className="pk pk-bob" style={anim(0, 4.4)}>
          <ellipse cx="0" cy="0" rx="14" ry="8.6" fill={url("fur")} stroke="#7a3410" strokeWidth="0.7" />
          <path d="M-12 -3 Q-2 -9 8 -6" stroke="#ffd2a6" strokeWidth="0.8" opacity="0.6" fill="none" strokeLinecap="round" />
          {/* tail wrapping round the front */}
          <path d="M-14 0 C-16 8 -4 10 8 8 C12 7.4 15 6 15 4 C8 6 -2 6 -10 2 Z" fill={url("fur")} stroke="#7a3410" strokeWidth="0.7" strokeLinejoin="round" />
          <path d="M8 8 C12 7.4 15 6 15 4 C12 4.6 10 5 7.4 5.4 Z" fill="#fff6ea" />
          {/* head resting on the tail */}
          <path d="M8 -6.4 L9.6 -13.6 L13.4 -7.4 Z" fill={url("fur")} stroke="#7a3410" strokeWidth="0.6" strokeLinejoin="round" />
          <path d="M13 -6.6 L17 -12.6 L18.6 -5.4 Z" fill={url("fur")} stroke="#7a3410" strokeWidth="0.6" strokeLinejoin="round" />
          <path d="M9.6 -11.6 L10.4 -8 L12 -8.6 Z M16.8 -10.6 L16.4 -7 L17.8 -6.6 Z" fill="#4a2010" />
          <ellipse cx="13.4" cy="-2.6" rx="6.4" ry="5.2" fill={url("fur")} stroke="#7a3410" strokeWidth="0.6" />
          <path d="M14 0.2 C16 1.6 19.6 1.4 21.4 -0.4 C19 -2 16.4 -2.4 14 0.2 Z" fill="#fff6ea" stroke="#c9a088" strokeWidth="0.4" />
          <circle cx="21.4" cy="-0.4" r="0.9" fill="#2a1408" />
          <path d="M11.4 -3.4 Q13.2 -2 15 -3.4" stroke="#3a1a08" strokeWidth="0.7" fill="none" strokeLinecap="round" />
        </g>
      </g>
      {[
        [118, 15, 0, 1],
        [124, 8, 1.1, 0.8],
      ].map(([x, y, d, s]) => (
        <g key={x} transform={`translate(${x} ${y}) scale(${s})`}>
          <path className="pk pk-rise" style={anim(d, 3.4)} d="M0 0 h3.2 l-3.2 3.2 h3.2" stroke="#fff4e0" strokeWidth="0.9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      ))}
      {[
        [80, 40, 30, "#f5862e"],
        [126, 41, -20, "#e8452c"],
        [70, 42, 80, "#f7c948"],
      ].map(([x, y, r, c]) => (
        <path key={x as number} d={MAPLE} transform={`translate(${x} ${y}) rotate(${r}) scale(0.4)`} fill={c as string} />
      ))}
    </>
  );
};

const nightOwl: Art = u => {
  const [id, url] = ids(u);
  const eye = (x: number) => (
    <g transform={`translate(${x} 21.6)`}>
      <circle r="3.9" fill="#f3e3c4" />
      <circle r="2.7" fill={url("iris")} stroke="#6a4a10" strokeWidth="0.3" />
      <circle r="1.4" fill="#1a1010" />
      <circle cx="0.7" cy="-0.7" r="0.55" fill="#fff" />
      <ellipse className="pk pk-blink" style={anim(0, 5)} rx="3" ry="2.9" fill="#7a5638" />
    </g>
  );
  return (
    <>
      <defs>
        <Lin id={id("sky")} c={["#141a3a", "#2c3266"]} />
        <Glow id={id("glow")} color="#fff2b8" opacity={0.35} />
        <Rad id={id("moon")} c={["#fffbe6", "#fbe9a8", "#e8c86a"]} />
        <Rad id={id("body")} c={["#b88a60", "#8a6040", "#5a3a22"]} />
        <Rad id={id("iris")} c={["#fff2a0", "#ffc928"]} />
      </defs>
      <rect width="132" height="44" fill={url("sky")} />
      <circle cx="112" cy="17" r="22" fill={url("glow")} />
      <circle cx="112" cy="17" r="12.5" fill={url("moon")} />
      <circle cx="108" cy="13" r="2.2" fill="#e8cf86" opacity="0.6" />
      <circle cx="117" cy="21" r="1.6" fill="#e8cf86" opacity="0.6" />
      <circle cx="116" cy="10" r="1" fill="#e8cf86" opacity="0.6" />
      {[
        [70, 8, 1.4, 0],
        [82, 30, 1.2, 0.8],
        [64, 22, 1, 1.6],
        [92, 6, 1.6, 0.4],
        [128, 37, 1.2, 1.2],
      ].map(([x, y, r, d]) => (
        <Sparkle key={x} x={x} y={y} r={r} fill="#fff8d6" d={d} />
      ))}
      <path d="M134 37 C118 35 104 37 86 40.6" stroke="#4a2e1e" strokeWidth="2.4" strokeLinecap="round" fill="none" />
      <path d="M120 36 C124 40 128 41 132 41" stroke="#4a2e1e" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      <g>
        <path d="M95 15 L96.2 9.6 L99.6 13.6 Z M109 15 L107.8 9.6 L104.4 13.6 Z" fill="#6a4a30" stroke="#3a2414" strokeWidth="0.5" strokeLinejoin="round" />
        <ellipse cx="102" cy="26" rx="8.6" ry="11" fill={url("body")} stroke="#3a2414" strokeWidth="0.7" />
        <ellipse cx="102" cy="30" rx="5.6" ry="6.4" fill="#ecd6b0" />
        <path d="M99.6 27 l1 1 l1 -1 M102.6 27 l1 1 l1 -1 M98.6 30.4 l1 1 l1 -1 M101.6 30.4 l1 1 l1 -1 M104.6 30.4 l1 1 l1 -1 M100 33.6 l1 1 l1 -1 M103 33.6 l1 1 l1 -1" stroke="#a07a50" strokeWidth="0.5" fill="none" />
        <ellipse cx="94.6" cy="28" rx="2.6" ry="6.4" transform="rotate(12 94.6 28)" fill="#6a4a30" stroke="#3a2414" strokeWidth="0.5" />
        <ellipse cx="109.4" cy="28" rx="2.6" ry="6.4" transform="rotate(-12 109.4 28)" fill="#6a4a30" stroke="#3a2414" strokeWidth="0.5" />
        {eye(98.2)}
        {eye(105.8)}
        <path d="M100.8 24.4 L103.2 24.4 L102 27 Z" fill="#f2a12a" stroke="#8a5a10" strokeWidth="0.4" strokeLinejoin="round" />
        <path d="M99 36.6 l0 2 M101 36.8 l0 2 M103 36.8 l0 2 M105 36.6 l0 2" stroke="#f2a12a" strokeWidth="0.9" strokeLinecap="round" />
      </g>
    </>
  );
};

const mushroomGrove: Art = u => {
  const [id, url] = ids(u);
  return (
    <>
      <defs>
        <Lin id={id("bg")} c={["#1c2e22", "#2c4a32"]} />
        <Glow id={id("glow")} color="#9ef0a0" opacity={0.3} />
        <Rad id={id("cap")} c={["#ff8a7a", "#e53935", "#a3161c"]} cx={0.4} cy={0.2} />
        <Rad id={id("tan")} c={["#f5c99a", "#d58a4a", "#8a4a1e"]} cx={0.4} cy={0.2} />
        <Rad id={id("blue")} c={["#d8fbff", "#6ee0ff", "#2a8ac9"]} cx={0.4} cy={0.2} />
        <Glow id={id("bglow")} color="#6ee0ff" opacity={0.6} />
        <Lin id={id("st")} c={["#fffaf0", "#e2d4bc"]} />
        <Lin id={id("moss")} c={["#5a9a48", "#2e5a2c"]} />
        <Glow id={id("fly")} color="#fff59a" opacity={0.9} />
      </defs>
      <rect width="132" height="44" fill={url("bg")} />
      <circle cx="104" cy="34" r="28" fill={url("glow")} />
      <path d="M70 40 Q72 30 70 22 Q74 30 75 38 M128 40 Q127 30 130 22 Q131 32 131 40" stroke="#4f8a3a" strokeWidth="1" fill="none" />
      <path d="M58 44 Q78 34 100 36 Q120 34 134 37 L134 44 Z" fill={url("moss")} />
      {/* big toadstool */}
      <path d="M100.6 41 Q99.8 32 101.6 24 L108.4 24 Q110.2 32 109.4 41 Q105 42.4 100.6 41 Z" fill={url("st")} stroke="#a8977c" strokeWidth="0.7" />
      <ellipse cx="105" cy="25.4" rx="11" ry="2.2" fill="#efe2cc" stroke="#a8977c" strokeWidth="0.5" />
      <path d="M92.4 25.4 C92 12.6 117.8 12 117.6 25.4 Q105 28.4 92.4 25.4 Z" fill={url("cap")} stroke="#7a1015" strokeWidth="0.8" />
      {[
        [97.4, 20, 2, 1.5],
        [104.6, 16.6, 2.4, 1.6],
        [111.8, 20.4, 1.8, 1.4],
        [101, 23.4, 1.3, 0.9],
        [108.6, 23.6, 1.1, 0.8],
      ].map(([x, y, rx, ry]) => (
        <ellipse key={x} cx={x} cy={y} rx={rx} ry={ry} fill="#fff" />
      ))}
      <path d="M95.6 19 Q98 15 103 14" stroke="#fff" strokeWidth="0.8" opacity="0.4" fill="none" strokeLinecap="round" />
      {/* two small brown ones */}
      <path d="M86 42 Q85.6 37 86.6 34 L89.4 34 Q90.2 37 89.8 42 Z" fill={url("st")} stroke="#a8977c" strokeWidth="0.5" />
      <path d="M82.4 34.6 C82.4 28.6 93.6 28.4 93.6 34.6 Q88 36 82.4 34.6 Z" fill={url("tan")} stroke="#6e3a14" strokeWidth="0.6" />
      <path d="M92.6 42 Q92.4 39 93 37.4 L94.8 37.4 Q95.2 39 95 42 Z" fill={url("st")} stroke="#a8977c" strokeWidth="0.4" />
      <path d="M90.6 37.8 C90.6 34 97.2 33.8 97.2 37.8 Q93.9 38.8 90.6 37.8 Z" fill={url("tan")} stroke="#6e3a14" strokeWidth="0.5" />
      {/* a glowing blue one */}
      <circle cx="124" cy="34" r="9" fill={url("bglow")} className="pk pk-pulse" style={anim(0, 3)} />
      <path d="M123 42 Q122.8 37.6 123.4 35 L125.4 35 Q125.8 37.6 125.6 42 Z" fill="#dff8ff" />
      <path d="M119.4 35.6 C119.6 30.4 129.6 30.4 129.4 35.6 Q124.4 37 119.4 35.6 Z" fill={url("blue")} stroke="#1f6a9a" strokeWidth="0.5" />
      <path d="M96 44 Q97 39 95.6 36 Q99 39.4 99.4 43 Q101 39.6 103 38 Q102 41 102.4 44 Z M110 44 Q111 40 110 37 Q113 40 113.4 43 Z" fill="#6aba4a" />
      {[
        [80, 18, 0],
        [118, 10, 0.9],
        [90, 8, 1.7],
      ].map(([x, y, d]) => (
        <g key={x}>
          <circle cx={x} cy={y} r="3.2" fill={url("fly")} className="pk pk-pulse" style={anim(d, 2.2)} />
          <circle cx={x} cy={y} r="0.7" fill="#fffbd1" />
        </g>
      ))}
    </>
  );
};

const starryNight: Art = u => {
  const [id, url] = ids(u);
  return (
    <>
      <defs>
        <Lin id={id("sky")} c={["#17173f", "#3a2f78"]} />
        <Glow id={id("glow")} color="#fff2c0" opacity={0.35} />
        <Rad id={id("moon")} c={["#fffbe6", "#fbe39a", "#e8c25a"]} />
        <mask id={id("cres")}>
          <circle cx="116" cy="13" r="8" fill="#fff" />
          <circle cx="120.4" cy="9.6" r="7" fill="#000" />
        </mask>
        <linearGradient id={id("trail")} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.9" />
        </linearGradient>
      </defs>
      <rect width="132" height="44" fill={url("sky")} />
      <ellipse cx="96" cy="16" rx="40" ry="6" transform="rotate(-14 96 16)" fill="#b9a8ff" opacity="0.08" />
      <circle cx="116" cy="13" r="16" fill={url("glow")} />
      <circle cx="116" cy="13" r="8" fill={url("moon")} mask={url("cres")} />
      {[
        [72, 8, 1.6, 0],
        [86, 18, 1.1, 0.6],
        [96, 6, 1.9, 1.2],
        [104, 24, 1.2, 1.8],
        [128, 26, 1.5, 0.3],
        [64, 20, 1, 0.9],
        [130, 6, 1.1, 1.5],
      ].map(([x, y, r, d]) => (
        <Sparkle key={x} x={x} y={y} r={r} fill="#fff8d6" d={d} />
      ))}
      {[
        [78, 13],
        [90, 26],
        [108, 8],
        [122, 30],
        [68, 30],
        [100, 15],
      ].map(([x, y]) => (
        <circle key={x} cx={x} cy={y} r="0.5" fill="#fff" opacity="0.7" />
      ))}
      <g transform="translate(84 6) rotate(22)">
        <g className="pk pk-shoot" style={anim(1, 6)}>
          <rect x="-14" y="-0.5" width="14" height="1" rx="0.5" fill={url("trail")} />
          <circle r="0.9" fill="#fff" />
        </g>
      </g>
      <path d="M60 44 Q80 30 100 34 Q116 28 134 32 L134 44 Z" fill="#2a2a62" />
      <path d="M70 44 Q92 36 112 40 Q124 37 134 39 L134 44 Z" fill="#17173a" />
      {[
        [96, 38, 7],
        [101, 39, 5],
        [128, 38, 6],
      ].map(([x, y, h]) => (
        <path key={x} d={`M${x} ${y - h} L${x + h * 0.4} ${y} L${x - h * 0.4} ${y} Z`} fill="#121230" />
      ))}
      <path d="M111 39 L111 35 L114 32.4 L117 35 L117 39 Z" fill="#121230" />
      <rect x="112.6" y="35.6" width="1.6" height="1.6" fill="#ffd96a" className="pk pk-flicker" />
    </>
  );
};

const cherryBlossom: Art = u => {
  const [id, url] = ids(u);
  return (
    <>
      <defs>
        <Lin id={id("sky")} c={["#4a2a44", "#8a4a6a"]} />
        <Glow id={id("glow")} color="#ffc4d8" opacity={0.45} />
        <Lin id={id("br")} c={["#5a3428", "#2e1a16"]} />
        <Rad id={id("p")} c={["#ffffff", "#ffd2e1", "#f59bbb"]} cx={0.5} cy={0.95} r={0.9} />
      </defs>
      <rect width="132" height="44" fill={url("sky")} />
      <circle cx="104" cy="20" r="26" fill={url("glow")} />
      <circle cx="98" cy="16" r="7.5" fill="#ffe6ee" opacity="0.45" />
      <path d="M134 3 C120 8 108 14 96 13 C88 12.5 82 16 74 22" stroke={url("br")} strokeWidth="2.8" strokeLinecap="round" fill="none" />
      <path d="M110 12 C112 18 116 24 125 28" stroke={url("br")} strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M90 13 C88 8 86 5 82 3" stroke={url("br")} strokeWidth="1.2" strokeLinecap="round" fill="none" />
      <Blossom x={96} y={12} s={1.15} r={10} fill={url("p")} />
      <Blossom x={82} y={4} s={0.85} r={-20} fill={url("p")} />
      <Blossom x={116} y={9} s={1} r={30} fill={url("p")} />
      <Blossom x={125} y={28} s={1.05} r={-5} fill={url("p")} />
      <Blossom x={77} y={20} s={0.8} r={15} fill={url("p")} />
      <Blossom x={116} y={21.6} s={0.75} r={40} fill={url("p")} />
      <Blossom x={130} y={4} s={0.8} r={0} fill={url("p")} />
      {[
        [104, 22, 0],
        [88, 24, 1.5],
        [120, 32, 2.6],
        [70, 30, 3.4],
      ].map(([x, y, d]) => (
        <g key={x} transform={`translate(${x} ${y})`}>
          <path className="pk pk-fall" style={anim(d, 5)} d="M0 0 C-2 -1 -2.3 -3.8 -0.8 -4.6 L0 -3.9 L0.8 -4.6 C2.3 -3.8 2 -1 0 0 Z" fill={url("p")} stroke="#d9668f" strokeWidth="0.35" />
        </g>
      ))}
    </>
  );
};

const sunflowers: Art = u => {
  const [id, url] = ids(u);
  const flower = (x: number, y: number, s: number) => (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      {Array.from({ length: 14 }, (_, i) => (
        <ellipse key={i} cx="0" cy="-6.4" rx="1.8" ry="4" transform={`rotate(${i * (360 / 14)})`} fill={url("petal")} stroke="#c47a0a" strokeWidth="0.4" />
      ))}
      <circle r="4.6" fill={url("disc")} stroke="#3a200c" strokeWidth="0.5" />
      {[
        [-1.6, -1.6],
        [1.4, -2],
        [2.2, 0.8],
        [-0.4, 0.6],
        [-2.4, 1.2],
        [0.8, 2.6],
      ].map(([sx, sy]) => (
        <circle key={`${sx}${sy}`} cx={sx} cy={sy} r="0.5" fill="#a8703a" />
      ))}
    </g>
  );
  return (
    <>
      <defs>
        <Lin id={id("sky")} c={["#5a3e18", "#b07a2a"]} />
        <Glow id={id("sun")} color="#ffe08a" opacity={0.55} />
        <Lin id={id("petal")} c={["#ffe680", "#f7b915"]} />
        <Rad id={id("disc")} c={["#8a5228", "#4a2810"]} />
        <Lin id={id("lf")} c={["#9be27a", "#3f8a3f"]} />
      </defs>
      <rect width="132" height="44" fill={url("sky")} />
      <circle cx="124" cy="6" r="22" fill={url("sun")} />
      <path d="M110 44 C110 36 111 30 110 24 M88 44 C88 38 89 34 88 30" stroke="#4f8a32" strokeWidth="1.8" fill="none" />
      {[
        [110, 36, -30, 1],
        [110, 32, 200, 0.9],
        [88, 39, 210, 0.8],
      ].map(([x, y, r, s]) => (
        <path key={`${x}${y}`} d="M0 0 C2.5 -4 8 -4.6 11 0 C8 4 2.5 3.6 0 0 Z" transform={`translate(${x} ${y}) rotate(${r}) scale(${s})`} fill={url("lf")} stroke="#2e6f34" strokeWidth="0.5" />
      ))}
      {flower(110, 17, 1.3)}
      {flower(88, 25, 0.85)}
      <g transform="translate(125 28)">
        <g className="pk pk-bob" style={anim(0, 1.8)}>
          <path d="M-5.6 -3 l-6 -1.4 M-5.6 -1 l-5.6 0.6" stroke="#ffe08a" strokeWidth="0.4" strokeDasharray="0.8 0.8" opacity="0.7" />
          <ellipse cx="-1" cy="-3.6" rx="2" ry="2.8" transform="rotate(-25 -1 -3.6)" fill="#eaf8ff" opacity="0.85" stroke="#9cc4d8" strokeWidth="0.3" />
          <ellipse cx="0" cy="0" rx="3.6" ry="2.6" fill="#ffd23a" stroke="#4a3008" strokeWidth="0.4" />
          <path d="M-1.4 -2.4 L-1.4 2.4 M0.8 -2.6 L0.8 2.6" stroke="#2a1a08" strokeWidth="0.9" />
          <circle cx="3.4" cy="-0.4" r="1.4" fill="#2a1a08" />
          <circle cx="3.8" cy="-0.8" r="0.4" fill="#fff" />
        </g>
      </g>
      <Sparkle x={74} y={10} r={1.4} fill="#fff4c0" d={0.6} />
    </>
  );
};

const snowyPines: Art = u => {
  const [id, url] = ids(u);
  const pine = (x: number, base: number, h: number, back?: boolean) => {
    const w = h * 0.42;
    const fill = back ? "#2c5a6a" : url("pine");
    return (
      <g key={x}>
        <rect x={x - 0.8} y={base - 3} width="1.6" height="3" fill="#4a2e1e" />
        {[0, 1, 2].map(i => {
          const top = base - h + i * h * 0.26;
          const bottom = top + h * 0.42;
          const half = w * (0.55 + i * 0.22);
          return (
            <g key={i}>
              <path d={`M${x} ${top} L${x + half} ${bottom} L${x - half} ${bottom} Z`} fill={fill} stroke="#123a2e" strokeWidth="0.4" strokeLinejoin="round" />
              <path d={`M${x} ${top} L${x + half * 0.55} ${top + h * 0.22} Q${x} ${top + h * 0.18} ${x - half * 0.55} ${top + h * 0.22} Z`} fill="#f4fbff" />
            </g>
          );
        })}
      </g>
    );
  };
  return (
    <>
      <defs>
        <Lin id={id("sky")} c={["#1e3254", "#4a76a2"]} />
        <Lin id={id("pine")} c={["#3a8a6a", "#1f5a46"]} />
        <Lin id={id("snow")} c={["#ffffff", "#c8def2"]} />
        <Glow id={id("glow")} color="#e8f4ff" opacity={0.4} />
      </defs>
      <rect width="132" height="44" fill={url("sky")} />
      <circle cx="122" cy="9" r="12" fill={url("glow")} />
      <circle cx="122" cy="9" r="4.4" fill="#f4f9ff" />
      {pine(84, 38, 22, true)}
      {pine(122, 37, 20, true)}
      {pine(96, 41, 32)}
      {pine(112, 42, 38)}
      {pine(128, 43, 26)}
      <path d="M60 44 Q80 36 100 39 Q118 36 134 39 L134 44 Z" fill={url("snow")} />
      {[
        [72, 4, 0],
        [86, 2, 1.2],
        [102, 6, 2.4],
        [118, 2, 0.6],
        [130, 10, 1.8],
        [92, 14, 3],
        [108, 16, 3.6],
        [78, 18, 2.1],
      ].map(([x, y, d]) => (
        <g key={x} transform={`translate(${x} ${y})`}>
          <circle className="pk pk-fall" style={anim(d, 4.4)} r="0.9" fill="#fff" />
        </g>
      ))}
    </>
  );
};

const oceanSunset: Art = u => {
  const [id, url] = ids(u);
  return (
    <>
      <defs>
        <Lin id={id("sky")} c={["#4a2560", "#c4506a", "#f2925a"]} />
        <Lin id={id("sun")} c={["#fff2a8", "#ffb35c", "#ff7a4a"]} />
        <Lin id={id("sea")} c={["#6a2e70", "#2a1440"]} />
        <Glow id={id("glow")} color="#ffd08a" opacity={0.5} />
      </defs>
      <rect width="132" height="44" fill={url("sky")} />
      <circle cx="104" cy="29" r="22" fill={url("glow")} />
      <circle cx="104" cy="29" r="10" fill={url("sun")} />
      <rect x="0" y="29" width="132" height="15" fill={url("sea")} />
      {[
        [104, 31.4, 14, 0],
        [104, 34, 10, 0.5],
        [104, 36.6, 7, 1],
        [104, 39.2, 4, 1.5],
      ].map(([x, y, w, d]) => (
        <rect key={y} className="pk pk-pulse" style={anim(d, 2.4)} x={x - w / 2} y={y} width={w} height="0.9" rx="0.45" fill="#ffc98a" />
      ))}
      <path d="M78 33 L90 33 L88 35 L80 35 Z" fill="#2a1430" />
      <path d="M84 32.6 L84 22 L90 32 Z" fill="#2a1430" />
      <path d="M83.4 32.6 L83.4 24 L79 32 Z" fill="#2a1430" />
      {/* palm */}
      <path d="M127 44 C126 36 124 28 120.6 20" stroke="#2a1430" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <g transform="translate(120.6 20)">
        <g className="pk pk-sway" style={anim(0, 5, "50% 50%")}>
          {[
            "M0 0 C-4 -4 -10 -4 -14 0 C-10 -2 -5 -1.6 0 0 Z",
            "M0 0 C-3 -6 -7 -9 -11 -9 C-7 -6 -4 -3 0 0 Z",
            "M0 0 C3 -5 8 -7 12 -6 C8 -4 4 -2 0 0 Z",
            "M0 0 C5 -1 10 1 13 5 C9 2.6 5 1.4 0 0 Z",
            "M0 0 C-4 0 -8 3 -9 7 C-6 3.6 -3 1.6 0 0 Z",
          ].map(d => (
            <path key={d} d={d} fill="#2a1430" />
          ))}
        </g>
      </g>
      {[
        [90, 12, 0],
        [98, 8, 0.8],
      ].map(([x, y, d]) => (
        <g key={x} transform={`translate(${x} ${y})`}>
          <path className="pk pk-bob" style={anim(d, 2.2)} d="M-3 0 Q-1.5 -1.6 0 0 Q1.5 -1.6 3 0" stroke="#3a1a40" strokeWidth="0.7" fill="none" strokeLinecap="round" />
        </g>
      ))}
    </>
  );
};

const tigerSparkle: Art = u => {
  const [id, url] = ids(u);
  const stripes = [
    "M70 0 C73 6 71 10 75 15 C72 11 70 6 68 0 Z",
    "M80 0 C84 8 81 13 87 19 C83 15 80 9 77 0 Z",
    "M93 0 C96 6 94 12 99 16 C95 13 92 8 90 0 Z",
    "M104 0 C108 9 104 15 111 22 C105 17 102 10 100 0 Z",
    "M118 0 C121 7 119 12 124 17 C120 14 117 8 115 0 Z",
    "M128 0 C131 6 130 10 134 13 L134 0 Z",
    "M76 44 C79 37 77 32 82 27 C79 33 80 38 79 44 Z",
    "M90 44 C92 35 89 30 95 23 C92 31 94 37 93 44 Z",
    "M106 44 C108 38 106 33 111 29 C108 34 110 39 109 44 Z",
    "M120 44 C122 36 119 31 125 25 C122 32 124 38 123 44 Z",
    "M64 44 C66 39 65 35 68 32 C66 36 67 40 67 44 Z",
  ];
  return (
    <>
      <defs>
        <Lin id={id("fur")} c={["#9a4614", "#e0802a", "#f6b450"]} h />
        <Glow id={id("sheen")} color="#fff2c8" opacity={0.4} />
      </defs>
      <rect width="132" height="44" fill={url("fur")} />
      <ellipse cx="108" cy="22" rx="24" ry="18" fill={url("sheen")} />
      {stripes.map(d => (
        <path key={d} d={d} fill="#2a1206" opacity="0.9" />
      ))}
      <Sparkle x={86} y={24} r={3.2} d={0} />
      <Sparkle x={114} y={11} r={2.6} fill="#fff6d0" d={0.7} />
      <Sparkle x={126} y={34} r={2.2} d={1.4} />
      <Sparkle x={100} y={36} r={1.6} fill="#fff6d0" d={2} />
      <Sparkle x={72} y={10} r={1.4} d={1.1} />
      {[
        [94, 18],
        [120, 22],
        [80, 34],
        [108, 30],
      ].map(([x, y]) => (
        <circle key={x} cx={x} cy={y} r="0.6" fill="#fff" opacity="0.9" />
      ))}
    </>
  );
};

const leopardSparkle: Art = u => {
  const [id, url] = ids(u);
  const rosette = (x: number, y: number, s: number, r: number) => (
    <g key={`${x}${y}`} transform={`translate(${x} ${y}) rotate(${r}) scale(${s})`}>
      <ellipse rx="3" ry="2.4" fill="#a8682a" />
      <path d="M-3.6 -1 C-4 -3 -2.4 -4 -1 -3.8" stroke="#2a1608" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <path d="M0.6 -3.8 C2.4 -4 3.8 -2.8 3.8 -1" stroke="#2a1608" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <path d="M3.8 0.8 C3.6 2.6 2 3.6 0.4 3.6" stroke="#2a1608" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <path d="M-1.2 3.6 C-3 3.4 -4 2 -3.8 0.6" stroke="#2a1608" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </g>
  );
  return (
    <>
      <defs>
        <Lin id={id("fur")} c={["#7a4e1c", "#c8924a", "#ecc27e"]} h />
        <Glow id={id("sheen")} color="#fff2d0" opacity={0.4} />
      </defs>
      <rect width="132" height="44" fill={url("fur")} />
      <ellipse cx="108" cy="22" rx="24" ry="18" fill={url("sheen")} />
      {[
        [72, 8, 0.9, 10],
        [84, 22, 1.1, -20],
        [76, 36, 0.9, 40],
        [96, 8, 1.2, 30],
        [100, 32, 1.1, -10],
        [112, 18, 1.2, 15],
        [124, 6, 1, -30],
        [126, 30, 1.2, 20],
        [114, 40, 0.8, 0],
        [64, 22, 0.7, 0],
      ].map(([x, y, s, r]) => rosette(x, y, s, r))}
      {[
        [90, 14],
        [106, 26],
        [120, 22],
        [92, 40],
      ].map(([x, y]) => (
        <circle key={x} cx={x} cy={y} r="0.9" fill="#2a1608" />
      ))}
      <Sparkle x={90} y={30} r={2.8} d={0.2} />
      <Sparkle x={118} y={10} r={2.4} fill="#fff6d0" d={1} />
      <Sparkle x={130} y={40} r={1.8} d={1.7} />
      <Sparkle x={106} y={38} r={1.4} fill="#fff6d0" d={2.3} />
    </>
  );
};

const crystalCave: Art = u => {
  const [id, url] = ids(u);
  const crystal = (x: number, base: number, h: number, w: number, r: number, light: string, dark: string) => (
    <g key={`${x}${r}`} transform={`translate(${x} ${base}) rotate(${r})`}>
      <path d={`M${-w} 0 L${-w} ${-h} L0 ${-h - w * 1.6} L0 0 Z`} fill={light} stroke="#2a1a50" strokeWidth="0.4" strokeLinejoin="round" />
      <path d={`M0 0 L0 ${-h - w * 1.6} L${w} ${-h} L${w} 0 Z`} fill={dark} stroke="#2a1a50" strokeWidth="0.4" strokeLinejoin="round" />
      <path d={`M${-w * 0.55} ${-1} L${-w * 0.55} ${-h * 0.9}`} stroke="#fff" strokeWidth="0.6" opacity="0.6" strokeLinecap="round" />
    </g>
  );
  return (
    <>
      <defs>
        <Lin id={id("bg")} c={["#1e1535", "#3a2560"]} />
        <Glow id={id("glow")} color="#b48cff" opacity={0.6} />
        <Lin id={id("cl")} c={["#d8fbff", "#6ee0ff"]} />
        <Lin id={id("cd")} c={["#6ec8ff", "#2a6ac9"]} />
        <Lin id={id("vl")} c={["#f0dcff", "#b48cff"]} />
        <Lin id={id("vd")} c={["#a070f0", "#5a32b0"]} />
        <Lin id={id("pl")} c={["#ffe0f0", "#ff8ac8"]} />
        <Lin id={id("pd")} c={["#f06ab0", "#a02a78"]} />
      </defs>
      <rect width="132" height="44" fill={url("bg")} />
      <circle cx="106" cy="32" r="26" fill={url("glow")} className="pk pk-pulse" style={anim(0, 4)} />
      {crystal(92, 42, 10, 3.2, -24, url("pl"), url("pd"))}
      {crystal(120, 42, 12, 3.4, 20, url("cl"), url("cd"))}
      {crystal(104, 42, 20, 4.6, -4, url("vl"), url("vd"))}
      {crystal(112, 42, 14, 3.6, 12, url("cl"), url("cd"))}
      {crystal(97, 42, 12, 3, -14, url("vl"), url("vd"))}
      {crystal(128, 43, 8, 2.6, 30, url("pl"), url("pd"))}
      <path d="M60 44 Q74 39 86 41 Q100 38 116 41 Q126 39 134 41 L134 44 Z" fill="#160f28" />
      <Sparkle x={100} y={8} r={2.4} fill="#f0e6ff" d={0} />
      <Sparkle x={122} y={16} r={1.8} fill="#d8fbff" d={0.9} />
      <Sparkle x={84} y={20} r={1.6} fill="#ffe0f0" d={1.6} />
      <Sparkle x={72} y={8} r={1.2} fill="#f0e6ff" d={2.2} />
    </>
  );
};

const cosmos: Art = u => {
  const [id, url] = ids(u);
  return (
    <>
      <defs>
        <Lin id={id("bg")} c={["#120d2e", "#2a1650"]} h />
        <Glow id={id("n1")} color="#ff6ad5" opacity={0.45} />
        <Glow id={id("n2")} color="#4fb0ff" opacity={0.4} />
        <Glow id={id("n3")} color="#8a5cff" opacity={0.5} />
        <Rad id={id("planet")} c={["#ffe0b8", "#f0915a", "#8a3a6a"]} />
        <Lin id={id("ring")} c={["#fff2d6", "#e8b48a"]} h />
      </defs>
      <rect width="132" height="44" fill={url("bg")} />
      <ellipse cx="92" cy="26" rx="26" ry="14" fill={url("n1")} />
      <ellipse cx="116" cy="14" rx="22" ry="14" fill={url("n2")} />
      <ellipse cx="104" cy="24" rx="30" ry="18" fill={url("n3")} />
      {[
        [70, 10, 1.4, 0],
        [80, 34, 1.2, 0.7],
        [128, 36, 1.6, 1.4],
        [94, 6, 1.1, 2],
        [126, 6, 1.2, 0.4],
      ].map(([x, y, r, d]) => (
        <Sparkle key={x} x={x} y={y} r={r} fill="#fff" d={d} />
      ))}
      {[
        [76, 22],
        [88, 14],
        [100, 38],
        [120, 28],
        [66, 32],
      ].map(([x, y]) => (
        <circle key={x} cx={x} cy={y} r="0.5" fill="#fff" opacity="0.8" />
      ))}
      <g transform="translate(108 22) rotate(-18)">
        <g className="pk pk-float" style={anim(0, 6)}>
          <path d="M-17 0 A17 4.6 0 0 1 17 0" stroke={url("ring")} strokeWidth="1.8" fill="none" />
          <circle r="9" fill={url("planet")} stroke="#5a2a4a" strokeWidth="0.5" />
          <path d="M-8.4 -2.6 Q0 -4.4 8.6 -2 M-8.8 1.8 Q0 0 8.8 2.4" stroke="#ffd2a6" strokeWidth="0.8" fill="none" opacity="0.5" />
          <path d="M17 0 A17 4.6 0 0 1 -17 0" stroke={url("ring")} strokeWidth="1.8" fill="none" />
          <path d="M-5 -6 Q-2 -8 1.6 -8" stroke="#fff" strokeWidth="0.8" opacity="0.6" fill="none" strokeLinecap="round" />
        </g>
      </g>
      <circle cx="84" cy="12" r="2.6" fill="#d8d0f0" />
      <circle cx="83.2" cy="11.2" r="0.8" fill="#fff" opacity="0.7" />
    </>
  );
};

const lanterns: Art = u => {
  const [id, url] = ids(u);
  const lantern = (x: number, y: number, s: number, d: number) => (
    <g key={x} transform={`translate(${x} ${y}) scale(${s})`}>
      <g className="pk pk-float" style={anim(d, 4.6)}>
        <circle r="8" fill={url("halo")} />
        <path d="M-4 -5 Q0 -6.2 4 -5 L5 4 Q0 5.6 -5 4 Z" fill={url("paper")} stroke="#a8401a" strokeWidth="0.4" />
        <path d="M-1.6 -5.6 L-2 4.8 M1.6 -5.6 L2 4.8" stroke="#e0782a" strokeWidth="0.3" opacity="0.6" />
        <ellipse cx="0" cy="4.4" rx="4" ry="1" fill="#fff1b8" />
        <path d="M-2.8 -3.6 Q-3.4 0 -3 3" stroke="#fff" strokeWidth="0.5" opacity="0.5" fill="none" />
      </g>
    </g>
  );
  return (
    <>
      <defs>
        <Lin id={id("sky")} c={["#221a40", "#4e2c56"]} />
        <Rad id={id("paper")} c={["#fff6c8", "#ffb347", "#e0602a"]} cx={0.5} cy={0.7} r={0.8} />
        <Glow id={id("halo")} color="#ffb347" opacity={0.45} />
      </defs>
      <rect width="132" height="44" fill={url("sky")} />
      {[
        [70, 6],
        [96, 4],
        [128, 12],
        [86, 30],
        [116, 30],
      ].map(([x, y]) => (
        <circle key={x} cx={x} cy={y} r="0.55" fill="#fff" opacity="0.8" />
      ))}
      <path d="M60 44 L76 32 L86 38 L100 26 L114 36 L124 30 L134 36 L134 44 Z" fill="#33284e" />
      <path d="M66 44 L84 38 L98 42 L112 36 L126 41 L134 39 L134 44 Z" fill="#1c1630" />
      {lantern(72, 26, 0.6, 1.2)}
      {lantern(86, 16, 0.85, 0.4)}
      {lantern(100, 26, 1.1, 2)}
      {lantern(114, 12, 1.3, 0)}
      {lantern(126, 27, 0.9, 1.6)}
    </>
  );
};

export const NAMEPLATE_ART: Record<string, Art> = {
  robin,
  "berry-mouse": berryMouse,
  "koi-pond": koiPond,
  "sleepy-fox": sleepyFox,
  "night-owl": nightOwl,
  "mushroom-grove": mushroomGrove,
  "starry-night": starryNight,
  "cherry-blossom": cherryBlossom,
  sunflowers,
  "snowy-pines": snowyPines,
  "ocean-sunset": oceanSunset,
  "tiger-sparkle": tigerSparkle,
  "leopard-sparkle": leopardSparkle,
  "crystal-cave": crystalCave,
  cosmos,
  lanterns,
};
