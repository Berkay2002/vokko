// Full-card profile effect scenes (ids in perks/catalog.ts PROFILE_EFFECTS with `scene: true`). Each scene is a set of actors: original
// inline SVG drawings placed on the card in % and sized in cqw (the scene is a size container), animated by the fx-* classes of
// ./scenes.css. An intro plays when the card mounts (fx-in / fx-once), then idle loops keep it alive (fx-bob, fx-travel, ...).
import type { CSSProperties, ReactNode } from "react";
import { Blossom, Glow, Lin, MAPLE, Maple, PETAL, Rad, Sparkle, ids, star5, type Art } from "./shared";
import "./scenes.css";

/** CSS variables of the fx-* classes; numbers are seconds. */
type Vars = Record<string, string | number>;
const vars = (v?: Vars): CSSProperties =>
  (v ? Object.fromEntries(Object.entries(v).map(([k, x]) => [`--${k}`, typeof x === "number" ? `${x}s` : x])) : {}) as CSSProperties;

/** Placement on the card: numbers are % of the card (left/right of its width, top/bottom of its height), strings any CSS length. */
interface Place {
  l?: number | string;
  r?: number | string;
  t?: number | string;
  b?: number | string;
  /** Width in cqw (% of the card's width). */
  w: number;
  z?: number;
}
const len = (x: number | string | undefined) => (typeof x === "number" ? `${x}%` : x);

/** One drawing on the card; `c` animates it (see scenes.css). */
const Act = ({ p, vb, c, v, children }: { p: Place; vb: string; c?: string; v?: Vars; children: ReactNode }) => (
  <svg
    className={`fx-a${c ? ` ${c}` : ""}`}
    viewBox={vb}
    style={{ left: len(p.l), right: len(p.r), top: len(p.t), bottom: len(p.b), width: `${p.w}cqw`, zIndex: p.z, ...vars(v) }}
  >
    {children}
  </svg>
);

/** An idle loop around part of a drawing (amplitudes in the drawing's own units). */
const I = ({ c, v, children, transform }: { c: string; v?: Vars; children: ReactNode; transform?: string }) => (
  <g transform={transform}>
    <g className={c} style={vars(v)}>
      {children}
    </g>
  </g>
);

/** Gradients shared by every actor of a scene (ids are document wide). */
const Defs = ({ children }: { children: ReactNode }) => (
  <svg className="fx-defs" width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
    <defs>{children}</defs>
  </svg>
);

/** Deterministic pseudo-random in [0, 1). */
const rnd = (i: number, salt: number): number => {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const f1 = (x: number) => Number(x.toFixed(1));

/** A point on a cubic Bezier. */
const bez = (p: number[], t: number): [number, number] => {
  const m = 1 - t;
  const a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
  return [a * p[0] + b * p[2] + c * p[4] + d * p[6], a * p[1] + b * p[3] + c * p[5] + d * p[7]];
};

/** Twinkling four-point stars scattered over the card. */
const stars = (n: number, salt: number, color = "#fff", area: [number, number, number, number] = [2, 2, 94, 70]) =>
  range(n).map(i => (
    <Act key={`s${i}`} p={{ l: f1(area[0] + rnd(i, salt) * area[2]), t: f1(area[1] + rnd(i, salt + 1) * area[3]), w: f1(1.6 + rnd(i, salt + 2) * 2.4) }} vb="-1 -1 2 2">
      <g className="fx-twinkle" style={vars({ it: f1(1.8 + rnd(i, salt + 3) * 2), id: f1(-rnd(i, salt + 4) * 3) })}>
        <path d="M0 -1 C0.14 -0.14 0.14 -0.14 1 0 C0.14 0.14 0.14 0.14 0 1 C-0.14 0.14 -0.14 0.14 -1 0 C-0.14 -0.14 -0.14 -0.14 0 -1 Z" fill={color} />
      </g>
    </Act>
  ));

const HEART = "M0 6 C-2.2 4.2 -6 2 -6 -1.4 C-6 -3.8 -4.2 -5.4 -2.4 -5.4 C-1.2 -5.4 -0.4 -4.8 0 -3.8 C0.4 -4.8 1.2 -5.4 2.4 -5.4 C4.2 -5.4 6 -3.8 6 -1.4 C6 2 2.2 4.2 0 6 Z";

// ---------------------------------------------------------------- Seasons

const sakuraBreeze: Art = u => {
  const [id, url] = ids(u);
  const bark = (d: string, w: number) => (
    <>
      <path d={d} stroke="#3f2219" strokeWidth={w + 1.6} strokeLinecap="round" fill="none" />
      <path d={d} stroke={url("bark")} strokeWidth={w} strokeLinecap="round" fill="none" />
    </>
  );
  const bud = (x: number, y: number, r: number) => (
    <g transform={`translate(${x} ${y}) rotate(${r})`}>
      <path d="M0 0 C-2.6 -1.6 -2.6 -5.6 0 -7.4 C2.6 -5.6 2.6 -1.6 0 0 Z" fill="#f48fb1" stroke="#c45883" strokeWidth="0.5" />
      <path d="M-1.8 0.4 L0 -2 L1.8 0.4 Z" fill="#6fa64a" />
    </g>
  );
  return (
    <>
      <Defs>
        <Lin id={id("bark")} c={["#9a6a50", "#6b3f2c", "#4e2c20"]} />
        <Rad id={id("pf")} c={["#fff7fa", "#ffd0e0", "#f59bbb"]} />
        <Lin id={id("pet")} c={["#ffeef4", "#f7a1c0"]} />
      </Defs>
      <Act p={{ t: -3, r: -4, w: 60, z: 2 }} vb="0 0 170 120" c="fx-in" v={{ x0: "30cqw", y0: "-30cqh", r0: "14deg", in: 1.7 }}>
        <I c="fx-sway" v={{ o: "100% 0%", sw: "2.5deg", it: 4.6 }}>
          {bark("M174 4 C150 10 128 22 108 38", 7.5)}
          {bark("M108 38 C92 50 76 56 54 60", 5)}
          {bark("M54 60 C40 62 28 68 16 80", 3)}
          {bark("M128 24 C126 40 120 52 112 62", 3)}
          {bark("M84 52 C86 66 82 78 74 88", 2.4)}
          {bark("M62 58 C58 48 50 42 40 40", 2)}
          {bark("M152 10 C150 22 146 30 140 36", 2.2)}
          <path d="M150 12 C138 18 128 24 116 32" stroke="#b98a6e" strokeWidth="1" strokeLinecap="round" fill="none" opacity="0.6" />
          {[
            [104, 44, 120], [66, 62, 160], [134, 30, 96], [86, 64, 70],
          ].map(([x, y, r], i) => (
            <g key={i} transform={`translate(${x} ${y}) rotate(${r}) scale(0.55)`}>
              <path d="M0 0 C3 -4.6 9 -5 12 0 C9 4.4 3 4.2 0 0 Z" fill="#8fd16a" stroke="#4a8a33" strokeWidth="0.8" />
              <path d="M1 0 Q6 -0.6 11 0" stroke="#4a8a33" strokeWidth="0.6" fill="none" />
            </g>
          ))}
          {bud(60, 46, -30)}
          {bud(122, 50, 20)}
          {bud(102, 70, 160)}
          {bud(30, 66, -60)}
          {[
            [112, 40, 1.3, 10], [94, 50, 1.0, 40], [70, 58, 1.15, -20], [112, 64, 0.95, 15], [74, 88, 1.05, 0],
            [40, 40, 0.9, 30], [16, 80, 0.95, -10], [140, 36, 1.0, 25], [150, 12, 0.85, 50], [48, 64, 0.75, 70],
          ].map(([x, y, s, r], i) => (
            <Blossom key={i} x={x} y={y} s={s} r={r} fill={url("pf")} />
          ))}
          <Sparkle x={128} y={52} r={3.2} d={0.4} />
          <Sparkle x={58} y={74} r={2.6} d={1.6} />
        </I>
      </Act>
      <div className="fx-layer fx-in" style={vars({ o0: 0, d: 0.7, in: 1.2 })}>
        {range(16).map(i => {
          const tt = 6 + rnd(i, 3) * 4;
          return (
            <Act
              key={i}
              p={{ l: 100, t: f1(rnd(i, 1) * 78), w: f1(3 + rnd(i, 2) * 2.6) }}
              vb="-5 -8 10 10"
              c="fx-travel"
              v={{ tt: f1(tt), td: f1(-rnd(i, 4) * tt), dx: "-125cqw", dy: `${f1(18 + rnd(i, 5) * 30)}cqh`, wx: "0px", wy: `${f1(3 + rnd(i, 6) * 5)}cqh`, rot: `${Math.round(360 + rnd(i, 7) * 360)}deg` }}
            >
              <g className="fx-tumble" style={vars({ it: f1(0.5 + rnd(i, 8) * 0.7), o: "center" })}>
                <path d={PETAL} transform="translate(0 2.5)" fill={url("pet")} stroke="#e57fa5" strokeWidth="0.4" />
                <path d="M0 2 L0 -2.6" stroke="#fff" strokeWidth="0.5" opacity="0.6" strokeLinecap="round" />
              </g>
            </Act>
          );
        })}
      </div>
    </>
  );
};

const LEAF_COLORS: [string, string][] = [
  ["#e8452c", "#8a2a14"],
  ["#f39a2b", "#9a5212"],
  ["#f7c948", "#a07a14"],
  ["#c0502a", "#6e2a14"],
  ["#d9622b", "#7f3412"],
];

const autumnCanopy: Art = u => {
  const [id, url] = ids(u);
  const cluster = (x: number, y: number, leaves: [number, number, number, number, number][], d: number) => (
    <I c="fx-sway" v={{ o: "50% 0%", sw: "5deg", it: f1(3.2 + d), id: -d }} transform={`translate(${x} ${y})`}>
      {leaves.map(([lx, ly, s, r, c], i) => (
        <Maple key={i} x={lx} y={ly} s={s} r={r} fill={LEAF_COLORS[c]![0]} edge={LEAF_COLORS[c]![1]} />
      ))}
    </I>
  );
  const acorn = (x: number, y: number) => (
    <I c="fx-sway" v={{ o: "50% 0%", sw: "8deg", it: 2.6 }} transform={`translate(${x} ${y})`}>
      <path d="M0 0 L0 5" stroke="#5a3426" strokeWidth="1" />
      <ellipse cx="0" cy="11" rx="4" ry="5.2" fill={url("nut")} stroke="#7a4a24" strokeWidth="0.7" />
      <path d="M-4.8 7.6 C-4.8 3.6 4.8 3.6 4.8 7.6 C2 8.8 -2 8.8 -4.8 7.6 Z" fill="#8a5a34" stroke="#5a3426" strokeWidth="0.7" />
      <path d="M-3 6 L-1.4 7.6 M0 5.4 L0 7.8 M3 6 L1.4 7.6" stroke="#5a3426" strokeWidth="0.5" />
      <ellipse cx="-1.4" cy="10" rx="1" ry="2" fill="#fff" opacity="0.4" />
    </I>
  );
  return (
    <>
      <Defs>
        <Lin id={id("bark")} c={["#8a5a40", "#5a3426"]} />
        <Lin id={id("nut")} c={["#e0a868", "#b0703a"]} />
      </Defs>
      <Act p={{ l: -3, t: -3, w: 106, z: 2 }} vb="0 0 300 64" c="fx-in" v={{ y0: "-28cqh", r0: "-3deg", in: 1.5 }}>
        <path d="M-6 9 C40 18 80 5 120 13 C160 21 200 7 240 15 C262 19 284 13 308 7" stroke="#3f2219" strokeWidth="8" strokeLinecap="round" fill="none" />
        <path d="M-6 9 C40 18 80 5 120 13 C160 21 200 7 240 15 C262 19 284 13 308 7" stroke={url("bark")} strokeWidth="6" strokeLinecap="round" fill="none" />
        <path d="M-6 7.6 C40 16 80 3.6 120 11.6" stroke="#a87858" strokeWidth="1.2" fill="none" opacity="0.6" />
        {["M60 11 C62 22 58 30 52 36", "M150 18 C152 28 160 34 168 38", "M232 14 C230 24 236 32 244 35", "M100 10 C104 18 112 22 120 25", "M20 12 C22 20 18 26 14 30"].map((d, i) => (
          <g key={i}>
            <path d={d} stroke="#3f2219" strokeWidth="3.4" strokeLinecap="round" fill="none" />
            <path d={d} stroke={url("bark")} strokeWidth="2.2" strokeLinecap="round" fill="none" />
          </g>
        ))}
        {cluster(52, 34, [[0, 4, 1.3, 10, 0], [-10, -2, 1.0, -30, 1], [9, -3, 1.05, 40, 2]], 0)}
        {cluster(168, 38, [[0, 4, 1.4, -10, 1], [-11, -4, 1.0, -40, 3], [10, -2, 1.1, 30, 0]], 0.8)}
        {cluster(244, 34, [[0, 4, 1.25, 5, 2], [-10, -3, 1.0, -35, 0], [10, -5, 0.95, 45, 4]], 1.4)}
        {cluster(120, 24, [[0, 4, 1.1, 0, 4], [-9, -2, 0.9, -30, 2]], 0.4)}
        {cluster(14, 30, [[0, 3, 1.1, 20, 3], [8, -4, 0.85, 50, 1]], 1.1)}
        {[
          [36, 13, 0.9, 160, 2], [82, 8, 1.0, 190, 0], [130, 16, 0.95, 170, 1], [196, 11, 1.0, 200, 3], [214, 13, 0.85, 150, 4], [276, 11, 0.95, 185, 0], [292, 8, 0.8, 160, 2],
        ].map(([x, y, s, r, c], i) => (
          <Maple key={i} x={x} y={y} s={s} r={r} fill={LEAF_COLORS[c]![0]} edge={LEAF_COLORS[c]![1]} />
        ))}
        {acorn(88, 10)}
        {acorn(206, 12)}
      </Act>
      <div className="fx-layer fx-in" style={vars({ o0: 0, d: 0.8, in: 1 })}>
        {range(11).map(i => {
          const tt = 7 + rnd(i, 13) * 4;
          const [fill, edge] = LEAF_COLORS[i % LEAF_COLORS.length]!;
          return (
            <Act
              key={i}
              p={{ l: f1(rnd(i, 11) * 94), t: f1(4 + rnd(i, 12) * 10), w: f1(4.5 + rnd(i, 14) * 2.5) }}
              vb="-8 -8 16 16"
              c="fx-travel"
              v={{ tt: f1(tt), td: f1(-rnd(i, 15) * tt), dx: `${f1((rnd(i, 16) - 0.5) * 30)}cqw`, dy: "100cqh", wx: `${f1(6 + rnd(i, 17) * 6)}cqw`, wy: "0px", rot: `${Math.round((rnd(i, 18) - 0.5) * 720)}deg` }}
            >
              <g className="fx-tumble" style={vars({ it: f1(0.8 + rnd(i, 19) * 0.8), o: "center" })}>
                <path d="M0 2.6 L0 6.4" stroke={edge} strokeWidth="0.9" strokeLinecap="round" />
                <path d={MAPLE} fill={fill} stroke={edge} strokeWidth="0.6" strokeLinejoin="round" />
                <path d="M0 2.4 L0 -4.6 M0 0.8 L4.2 -2.1 M0 0.8 L-4.2 -2.1" stroke={edge} strokeWidth="0.4" opacity="0.7" />
              </g>
            </Act>
          );
        })}
      </div>
    </>
  );
};

const winterWonderland: Art = u => {
  const [id, url] = ids(u);
  const stem = [-4, 6, 30, 14, 70, 22, 124, 42];
  const side = [42, 16, 52, 32, 58, 44, 64, 60];
  const tufts = (p: number[], n: number, from: number) =>
    range(n).map(i => {
      const [x, y] = bez(p, from + (i / (n - 1)) * (1 - from));
      const len = 11 - (i / n) * 4;
      return (
        <g key={i} transform={`translate(${f1(x)} ${f1(y)})`}>
          {[-70, -40, -10, 20, 50, 110, 140, 170, 200, 230].map((a, k) => (
            <path
              key={k}
              d={`M0 0 L${f1(Math.cos(((a + 25) * Math.PI) / 180) * len)} ${f1(Math.sin(((a + 25) * Math.PI) / 180) * len)}`}
              stroke={["#2f6b3e", "#3f8a50", "#1f5232"][(i + k) % 3]}
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          ))}
        </g>
      );
    });
  const snowCaps = (p: number[], n: number) =>
    range(n).map(i => {
      const [x, y] = bez(p, 0.08 + (i / n) * 0.9);
      return <ellipse key={i} cx={f1(x)} cy={f1(y - 5)} rx={f1(7 - i * 0.3)} ry="3.2" transform={`rotate(14 ${f1(x)} ${f1(y - 5)})`} fill="#fff" stroke="#cfe3f2" strokeWidth="0.6" />;
    });
  return (
    <>
      <Defs>
        <Rad id={id("snow")} c={["#ffffff", "#f1f8fd", "#cfe3f2"]} />
        <Rad id={id("orn")} c={["#ff9a9a", "#e2343c", "#9a1420"]} />
        <Lin id={id("scarf")} c={["#ff5f6d", "#c8283a"]} />
      </Defs>
      <Act p={{ l: -3, t: -3, w: 54, z: 2 }} vb="0 0 150 96" c="fx-in" v={{ x0: "-30cqw", y0: "-22cqh", r0: "-12deg", in: 1.6 }}>
        <I c="fx-sway" v={{ o: "0% 0%", sw: "2deg", it: 5 }}>
          <path d="M-4 6 C30 14 70 22 124 42" stroke="#5a3a26" strokeWidth="3" strokeLinecap="round" fill="none" />
          <path d="M42 16 C52 32 58 44 64 60" stroke="#5a3a26" strokeWidth="2.2" strokeLinecap="round" fill="none" />
          {tufts(stem, 13, 0.04)}
          {tufts(side, 6, 0.15)}
          {snowCaps(stem, 9)}
          {snowCaps(side, 3)}
          <I c="fx-sway" v={{ o: "50% 0%", sw: "9deg", it: 2.4 }} transform="translate(64 60)">
            <path d="M0 0 L0 9" stroke="#d6b04a" strokeWidth="0.8" />
            <rect x="-2.4" y="8" width="4.8" height="3" rx="0.8" fill="#e8c35a" stroke="#9a7420" strokeWidth="0.5" />
            <circle cx="0" cy="18" r="7.4" fill={url("orn")} stroke="#7a0f18" strokeWidth="0.8" />
            <path d="M-6 16 Q0 13 6 16 M-6.6 20 Q0 23 6.6 20" stroke="#ffd36b" strokeWidth="1" fill="none" />
            <ellipse cx="-2.6" cy="15" rx="2" ry="1.2" fill="#fff" opacity="0.7" transform="rotate(-30 -2.6 15)" />
          </I>
          <Sparkle x={100} y={26} r={3} d={0.3} />
          <Sparkle x={24} y={22} r={2.4} d={1.3} />
        </I>
      </Act>
      <Act p={{ l: 4, b: -2, w: 24, z: 3 }} vb="0 0 70 96" c="fx-in" v={{ y0: "34cqw", d: 0.5, in: 1.4 }}>
        <I c="fx-bob" v={{ amp: "1px", it: 2.2 }}>
          <circle cx="35" cy="78" r="22" fill={url("snow")} stroke="#a9c8dd" strokeWidth="1.2" />
          <path d="M14 44 L2 30 M6 34 L1 36 M6 34 L4 28" stroke="#6b4428" strokeWidth="2" strokeLinecap="round" fill="none" />
          <I c="fx-sway" v={{ o: "0% 100%", sw: "14deg", it: 0.7 }} transform="translate(56 46)">
            <path d="M0 0 L12 -14 M8 -9 L13 -9 M10 -12 L9 -18" stroke="#6b4428" strokeWidth="2" strokeLinecap="round" fill="none" />
          </I>
          <circle cx="35" cy="40" r="15" fill={url("snow")} stroke="#a9c8dd" strokeWidth="1.2" />
          <rect x="22" y="10" width="26" height="4" rx="1.5" fill="#2a2a36" />
          <rect x="26" y="-6" width="18" height="18" rx="2" fill="#2a2a36" />
          <rect x="26" y="6" width="18" height="3.4" fill="#e2343c" />
          <circle cx="30" cy="38" r="1.8" fill="#23232e" />
          <circle cx="41" cy="38" r="1.8" fill="#23232e" />
          <circle cx="30.6" cy="37.4" r="0.6" fill="#fff" />
          <circle cx="41.6" cy="37.4" r="0.6" fill="#fff" />
          <path d="M35 42 L48 45 L35 45.6 Z" fill="#ff8a2a" stroke="#c45a10" strokeWidth="0.7" strokeLinejoin="round" />
          {[[28, 48], [31.5, 50], [35.5, 50.6], [39.5, 50], [43, 48]].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="0.9" fill="#23232e" />
          ))}
          <ellipse cx="25.5" cy="44" rx="2.6" ry="1.5" fill="#ff9ab0" opacity="0.6" />
          <ellipse cx="45" cy="44" rx="2.6" ry="1.5" fill="#ff9ab0" opacity="0.6" />
          <path d="M20 54 C28 58 42 58 50 54 L50 59 C42 63 28 63 20 59 Z" fill={url("scarf")} stroke="#8a1424" strokeWidth="0.8" />
          <path d="M42 58 L44 76 L50 75 L47 58 Z" fill={url("scarf")} stroke="#8a1424" strokeWidth="0.8" />
          <path d="M44 72 L50 71 M43.5 67 L49 66" stroke="#fff" strokeWidth="1" opacity="0.8" />
          <circle cx="35" cy="70" r="1.8" fill="#23232e" />
          <circle cx="35" cy="80" r="1.8" fill="#23232e" />
        </I>
      </Act>
      {range(20).map(i => {
        const tt = 7 + rnd(i, 23) * 5;
        const s = 1.2 + rnd(i, 22) * 1.6;
        return (
          <Act
            key={i}
            p={{ l: f1(rnd(i, 21) * 96), t: -4, w: f1(s) }}
            vb="-6 -6 12 12"
            c="fx-travel"
            v={{ tt: f1(tt), td: f1(-rnd(i, 24) * tt), dx: `${f1((rnd(i, 25) - 0.5) * 16)}cqw`, dy: "108cqh", wx: `${f1(2 + rnd(i, 26) * 4)}cqw`, wy: "0px", rot: "200deg", op: 0.95 }}
          >
            {i % 3 === 0 ? (
              <g stroke="#fff" strokeWidth="1.1" strokeLinecap="round">
                {[0, 60, 120].map(a => (
                  <path key={a} d="M0 -5 L0 5 M-1.6 -3.6 L0 -2.4 L1.6 -3.6 M-1.6 3.6 L0 2.4 L1.6 3.6" transform={`rotate(${a})`} fill="none" />
                ))}
              </g>
            ) : (
              <circle r="3.4" fill="#fff" opacity="0.9" />
            )}
          </Act>
        );
      })}
    </>
  );
};

const spookyNight: Art = u => {
  const [id, url] = ids(u);
  const bat = (
    <>
      <g className="pk pk-flap" style={{ animationDuration: "0.3s", transformOrigin: "100% 40%" }}>
        <path d="M-2 -1 C-6 -6 -11 -7 -15 -4 C-13 -3 -13 -1 -14 1 C-12 0 -10 0 -9 2 C-8 0 -6 0 -5 2 C-4 0 -3 0 -2 1 Z" fill="#2a1f3d" />
      </g>
      <g className="pk pk-flap" style={{ animationDuration: "0.3s", transformOrigin: "0% 40%" }}>
        <path d="M2 -1 C6 -6 11 -7 15 -4 C13 -3 13 -1 14 1 C12 0 10 0 9 2 C8 0 6 0 5 2 C4 0 3 0 2 1 Z" fill="#2a1f3d" />
      </g>
      <ellipse rx="2.8" ry="3.6" fill="#33264a" />
      <path d="M-2 -3 L-2.4 -5.6 L-0.8 -3.6 M2 -3 L2.4 -5.6 L0.8 -3.6" fill="#33264a" stroke="#33264a" strokeWidth="0.6" strokeLinejoin="round" />
      <circle cx="-1" cy="-1" r="0.6" fill="#ffd34d" />
      <circle cx="1" cy="-1" r="0.6" fill="#ffd34d" />
    </>
  );
  return (
    <>
      <Defs>
        <Rad id={id("moon")} c={["#fffbe6", "#ffe9a0", "#f0c060"]} />
        <Glow id={id("mg")} color="#ffe9a0" opacity={0.55} />
        <Lin id={id("ghost")} c={["#ffffff", "#f1eefc", "#d9d2f2"]} />
        <Rad id={id("pump")} c={["#ffc070", "#ff8a1e", "#c2520c"]} />
        <Glow id={id("pg")} color="#ffb02e" opacity={0.7} />
      </Defs>
      <Act p={{ r: 4, t: 2, w: 26 }} vb="-30 -30 60 60" c="fx-in" v={{ s0: 0.4, o0: 0, in: 1.6 }}>
        <circle r="30" fill={url("mg")} className="pk pk-pulse" style={{ animationDuration: "4s" }} />
        <circle r="14" fill={url("moon")} stroke="#e0a848" strokeWidth="0.8" />
        <circle cx="-4" cy="-3" r="3" fill="#e8bb5a" opacity="0.5" />
        <circle cx="5" cy="4" r="2.2" fill="#e8bb5a" opacity="0.5" />
        <circle cx="-2" cy="7" r="1.4" fill="#e8bb5a" opacity="0.5" />
        <circle cx="6" cy="-6" r="1.2" fill="#e8bb5a" opacity="0.45" />
      </Act>
      {[
        [12, 9, -1, 0.95],
        [24, 11, -4.5, 0.8],
        [36, 13, -8, 0.7],
      ].map(([t, tt, td, s], i) => (
        <Act key={i} p={{ l: -14, t: t!, w: f1(13 * s!) }} vb="-16 -8 32 16" c="fx-travel" v={{ tt: tt!, td: td!, dx: "130cqw", dy: "-8cqh", wx: "0px", wy: "5cqh" }}>
          {bat}
        </Act>
      ))}
      <Act p={{ l: 6, b: 4, w: 19, z: 2 }} vb="0 0 50 60" c="fx-in" v={{ y0: "30cqh", o0: 0, d: 0.3, in: 1.8 }}>
        <I c="fx-bob" v={{ amp: "4px", it: 2.6 }}>
          <ellipse cx="25" cy="58" rx="14" ry="2.4" fill="#000" opacity="0.18" />
          <path
            d="M25 4 C12 4 5 14 5 28 V50 Q9 45 13 50 Q17 55 21 50 Q25 45 29 50 Q33 55 37 50 Q41 45 45 50 V28 C45 14 38 4 25 4 Z"
            fill={url("ghost")}
            stroke="#a89fcf"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path d="M5 30 C1 30 0 36 3 38 C5 36 6 34 6 32 M45 30 C49 30 50 36 47 38 C45 36 44 34 44 32" fill="#f1eefc" stroke="#a89fcf" strokeWidth="1" />
          <ellipse cx="18.5" cy="25" rx="3" ry="4" fill="#2a2440" />
          <ellipse cx="31.5" cy="25" rx="3" ry="4" fill="#2a2440" />
          <circle cx="19.4" cy="23.6" r="1.1" fill="#fff" />
          <circle cx="32.4" cy="23.6" r="1.1" fill="#fff" />
          <ellipse cx="13" cy="31" rx="3" ry="1.7" fill="#ff9ec4" opacity="0.6" />
          <ellipse cx="37" cy="31" rx="3" ry="1.7" fill="#ff9ec4" opacity="0.6" />
          <ellipse cx="25" cy="33" rx="2.2" ry="2.8" fill="#2a2440" />
          <path d="M12 10 C16 7 20 6 24 6" stroke="#fff" strokeWidth="2" strokeLinecap="round" fill="none" opacity="0.9" />
        </I>
      </Act>
      <Act p={{ r: 5, b: 2, w: 18, z: 2 }} vb="-26 -24 52 44" c="fx-in" v={{ s0: 0.2, o0: 0, d: 1, in: 0.9 }}>
        <circle r="24" fill={url("pg")} className="pk pk-flicker" />
        <path d="M0 -12 C2 -16 4 -18 7 -19" stroke="#4f7a2a" strokeWidth="2.4" strokeLinecap="round" fill="none" />
        <ellipse cx="-9" cy="2" rx="11" ry="13" fill={url("pump")} stroke="#9a3e08" strokeWidth="0.9" />
        <ellipse cx="9" cy="2" rx="11" ry="13" fill={url("pump")} stroke="#9a3e08" strokeWidth="0.9" />
        <ellipse cx="0" cy="2" rx="9" ry="14" fill={url("pump")} stroke="#9a3e08" strokeWidth="0.9" />
        <g className="pk pk-flicker" fill="#ffe27a" stroke="#b8540c" strokeWidth="0.5" strokeLinejoin="round">
          <path d="M-10 -3 L-5 -3 L-7.5 -8 Z" />
          <path d="M10 -3 L5 -3 L7.5 -8 Z" />
          <path d="M-1.6 1 L1.6 1 L0 -2 Z" />
          <path d="M-11 5 C-6 11 6 11 11 5 L7 6 L5 9 L2 6.6 L-2 6.6 L-5 9 L-7 6 Z" />
        </g>
      </Act>
      {stars(6, 31, "#fff6c8", [2, 4, 60, 30])}
    </>
  );
};

// ---------------------------------------------------------------- Fantasy & Space

const jadeDragon: Art = u => {
  const [id, url] = ids(u);
  const spine = "M8 70 C30 44 52 42 70 60 S104 84 124 64 S156 34 176 44";
  const cloud = (
    <>
      <path
        d="M6 24 C2 24 0 20 2 17 C4 14 8 14 10 16 C10 10 16 6 22 8 C24 2 34 0 40 4 C44 0 54 0 58 6 C64 4 72 8 72 14 C78 14 80 20 76 24 Z"
        fill="#fff8e6"
        stroke="#e2b968"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M20 18 C20 14 25 13 26 16 C27 18 24 19 23.4 17.6 M44 16 C44 11 50 10 51 14 C52 17 48 18 47.6 16.4" stroke="#e2b968" strokeWidth="1.1" fill="none" strokeLinecap="round" />
    </>
  );
  const leg = (x: number, y: number, r: number) => (
    <g transform={`translate(${x} ${y}) rotate(${r})`}>
      <path d="M0 0 C1 6 4 10 9 11" stroke="#14563a" strokeWidth="6" strokeLinecap="round" fill="none" />
      <path d="M0 0 C1 6 4 10 9 11" stroke={url("body")} strokeWidth="4" strokeLinecap="round" fill="none" />
      <path d="M9 11 L14 9 M9 11 L14 13 M9 11 L12 16" stroke="#f6e7a6" strokeWidth="1.4" strokeLinecap="round" />
    </g>
  );
  return (
    <>
      <Defs>
        <Lin id={id("body")} c={["#8ff0b4", "#33b06c", "#1d7a4a"]} />
        <Lin id={id("head")} c={["#a6f5c4", "#3cbd76", "#1f8150"]} />
        <Rad id={id("pearl")} c={["#ffffff", "#fff0c0", "#f2b640"]} />
        <Glow id={id("pg")} color="#ffe08a" opacity={0.75} />
        <Lin id={id("mane")} c={["#ffb04a", "#e8562a"]} />
      </Defs>
      <Act p={{ l: 3, t: 5, w: 28 }} vb="0 0 80 28" c="fx-in" v={{ x0: "-20cqw", o0: 0, in: 1.4 }}>
        <I c="fx-bob" v={{ amp: "2px", it: 4 }}>
          {cloud}
        </I>
      </Act>
      <Act p={{ r: 3, t: 34, w: 20 }} vb="0 0 80 28" c="fx-in" v={{ x0: "20cqw", o0: 0, d: 0.4, in: 1.4 }}>
        <I c="fx-bob" v={{ amp: "2px", it: 5, id: -1.5 }}>
          {cloud}
        </I>
      </Act>
      <Act p={{ r: -3, t: 1, w: 66, z: 2 }} vb="-6 0 228 100" c="fx-in" v={{ x0: "-125cqw", y0: "22cqh", r0: "-8deg", in: 2.8, ease: "cubic-bezier(0.25, 0.6, 0.3, 1)" }}>
        <I c="fx-bob" v={{ amp: "3px", it: 2.8 }}>
          {/* tail tuft */}
          <path d="M10 68 C2 64 -6 72 -4 82 C0 76 4 76 8 76 C4 80 4 86 8 90 C10 82 14 78 14 72 Z" fill={url("mane")} stroke="#9a2f12" strokeWidth="1" strokeLinejoin="round" />
          {leg(96, 80, 10)}
          {leg(40, 52, 30)}
          {/* body: frill, outline, scales, belly */}
          <path d={spine} stroke={url("mane")} strokeWidth="22" strokeDasharray="5 4" fill="none" />
          <path d={spine} stroke="#14563a" strokeWidth="15.5" strokeLinecap="round" fill="none" />
          <path d={spine} stroke={url("body")} strokeWidth="13" strokeLinecap="round" fill="none" />
          <path d={spine} stroke="#f6e7a6" strokeWidth="4.2" strokeLinecap="round" fill="none" transform="translate(0 3.2)" />
          <path d={spine} stroke="#c9b26a" strokeWidth="4.2" strokeDasharray="0.8 3" fill="none" transform="translate(0 3.2)" />
          <path d={spine} stroke="#1d7a4a" strokeWidth="1.4" strokeDasharray="1.6 3.4" fill="none" transform="translate(0 -2.6)" />
          <path d={spine} stroke="#c8ffe0" strokeWidth="1.2" fill="none" transform="translate(0 -4.6)" opacity="0.6" />
          {leg(150, 48, -10)}
          {leg(66, 62, -20)}
          {/* head */}
          <g transform="translate(176 42)">
            <path d="M-6 -6 C-14 -18 -6 -24 2 -16 C2 -26 12 -26 10 -14 C16 -22 22 -18 16 -10" fill={url("mane")} stroke="#9a2f12" strokeWidth="1" strokeLinejoin="round" />
            <path d="M-4 -10 C-8 -20 -14 -26 -22 -28 M-10 -21 L-16 -18 M2 -12 C2 -22 -2 -30 -8 -34 M-1 -24 L-6 -23" stroke="#a88440" strokeWidth="3.4" strokeLinecap="round" fill="none" />
            <path d="M-4 -10 C-8 -20 -14 -26 -22 -28 M-10 -21 L-16 -18 M2 -12 C2 -22 -2 -30 -8 -34 M-1 -24 L-6 -23" stroke="#f6e9c0" strokeWidth="2" strokeLinecap="round" fill="none" />
            <path d="M14 8 C20 11 28 13 33 10 C29 17 18 17 9 12 Z" fill="#2fa968" stroke="#14563a" strokeWidth="1.2" strokeLinejoin="round" />
            <path d="M15 9 C20 11 26 12 30 11 L28 13 C24 14 18 13 14 11 Z" fill="#c2304a" />
            <path
              d="M-8 -4 C0 -14 16 -13 24 -7 C30 -5 35 -3 35 2 C35 6 29 7 23 6 L14 8 C8 12 -2 11 -7 5 Z"
              fill={url("head")}
              stroke="#14563a"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
            <path d="M24 6 L25 9 L26.4 6 M28 6 L29 8.6 L30.2 6" fill="#fff" />
            <path d="M2 -9 C8 -12 16 -11 22 -7" stroke="#c8ffe0" strokeWidth="1.4" fill="none" strokeLinecap="round" opacity="0.8" />
            <circle cx="31" cy="-0.6" r="1.1" fill="#14563a" />
            <path d="M3 -8 C7 -11 13 -10 15 -7" stroke="#14563a" strokeWidth="1.6" fill="none" strokeLinecap="round" />
            <ellipse cx="9.5" cy="-4.4" rx="3.4" ry="2.4" fill="#ffe066" stroke="#14563a" strokeWidth="0.9" />
            <ellipse cx="10.2" cy="-4.4" rx="0.9" ry="2" fill="#14381f" />
            <path d="M-2 4 C2 8 6 9 10 9" stroke="#1d7a4a" strokeWidth="1" fill="none" />
            <I c="fx-sway" v={{ o: "0% 0%", sw: "7deg", it: 1.8 }} transform="translate(28 4)">
              <path d="M0 0 C10 6 16 18 10 28" stroke="#f6e9c0" strokeWidth="1.5" strokeLinecap="round" fill="none" />
            </I>
            <I c="fx-sway" v={{ o: "0% 100%", sw: "6deg", it: 2.2, id: -0.8 }} transform="translate(26 -2)">
              <path d="M0 0 C12 -8 22 -4 26 4" stroke="#f6e9c0" strokeWidth="1.5" strokeLinecap="round" fill="none" />
            </I>
          </g>
        </I>
      </Act>
      <Act p={{ r: 1, t: 24, w: 12, z: 3 }} vb="-16 -16 32 32" c="fx-in" v={{ x0: "-110cqw", y0: "18cqh", in: 2.7, ease: "cubic-bezier(0.25, 0.6, 0.3, 1)" }}>
        <I c="fx-bob" v={{ amp: "2.5px", it: 2, id: -0.6 }}>
          <circle r="16" fill={url("pg")} className="pk pk-pulse" />
          <circle r="6.4" fill={url("pearl")} stroke="#d49a2a" strokeWidth="0.6" />
          <ellipse cx="-2" cy="-2.4" rx="2" ry="1.2" fill="#fff" />
          <path d="M-9 -9 L-7 -7 M9 -9 L7 -7 M0 -12 L0 -9.4" stroke="#fff3c0" strokeWidth="1" strokeLinecap="round" />
        </I>
      </Act>
      {stars(5, 41, "#fff3c0", [4, 2, 90, 40])}
    </>
  );
};

/** Points of a logarithmic spiral arm as a path. */
const spiral = (turn: number, a: number, b: number, from: number, to: number) => {
  const pts = range(40).map(i => {
    const t = from + ((to - from) * i) / 39;
    const r = a * Math.exp(b * t);
    return `${f1(Math.cos(t + turn) * r)} ${f1(Math.sin(t + turn) * r)}`;
  });
  return `M${pts.join(" L")}`;
};

const galaxySwirl: Art = u => {
  const [id, url] = ids(u);
  const arms = [0, Math.PI];
  return (
    <>
      <Defs>
        <Glow id={id("g1")} color="#b48bff" opacity={0.6} />
        <Glow id={id("g2")} color="#6fc3ff" opacity={0.55} />
        <Rad id={id("core")} c={["#ffffff", "#fff2c8", "#ffc8f0"]} cx={0.5} cy={0.5} r={0.5} />
        <Rad id={id("planet")} c={["#ffc4a0", "#ff7f6a", "#a83a62"]} />
      </Defs>
      <Act p={{ r: 0, t: 0, w: 52 }} vb="-50 -50 100 100" c="fx-in" v={{ s0: 0.1, r0: "-220deg", o0: 0, in: 2.2 }}>
        <circle r="50" fill={url("g1")} />
        <circle r="28" fill={url("g2")} />
        <g className="fx-spin" style={vars({ it: 36 })}>
          {arms.map(turn => (
            <g key={turn}>
              <path d={spiral(turn, 3, 0.3, 0, 8.4)} stroke="#c9a8ff" strokeWidth="9" strokeLinecap="round" fill="none" opacity="0.22" />
              <path d={spiral(turn, 3, 0.3, 0, 8.4)} stroke="#e4d4ff" strokeWidth="3.4" strokeLinecap="round" fill="none" opacity="0.55" />
              <path d={spiral(turn, 3, 0.3, 0.6, 7.6)} stroke="#ffffff" strokeWidth="1" strokeLinecap="round" fill="none" opacity="0.8" />
              {range(16).map(i => {
                const t = 1 + i * 0.45;
                const r = 3 * Math.exp(0.3 * t) + (rnd(i, turn + 5) - 0.5) * 6;
                return <circle key={i} cx={f1(Math.cos(t + turn) * r)} cy={f1(Math.sin(t + turn) * r)} r={f1(0.5 + rnd(i, turn + 9) * 1.1)} fill={i % 3 ? "#fff" : "#ffd6f5"} />;
              })}
            </g>
          ))}
          <circle r="6.5" fill={url("core")} />
        </g>
      </Act>
      <Act p={{ l: 5, b: 9, w: 19, z: 2 }} vb="-20 -14 40 28" c="fx-in" v={{ x0: "-34cqw", o0: 0, d: 0.6, in: 1.8 }}>
        <I c="fx-rock" v={{ amp: "1.5px", sw: "4deg", it: 4 }}>
          <path d="M-17 2 A17 4.6 -12 0 1 17 -5" stroke="#ffd9a8" strokeWidth="1.8" fill="none" opacity="0.8" />
          <circle r="9" fill={url("planet")} stroke="#7a2848" strokeWidth="0.7" />
          <path d="M-8.4 -3 C-3 -1 3 -5 8.6 -2.6 M-8.8 2 C-3 4 3 0 8.8 2.6" stroke="#ffd1b8" strokeWidth="1.2" fill="none" opacity="0.6" />
          <ellipse cx="-3.4" cy="-4" rx="2.4" ry="1.4" fill="#fff" opacity="0.5" />
          <path d="M-17 2 A17 4.6 -12 0 0 17 -5" stroke="#ffd9a8" strokeWidth="2" fill="none" />
        </I>
      </Act>
      <Act p={{ l: -24, t: 16, w: 26 }} vb="0 0 60 12" c="fx-travel" v={{ tt: 4.5, td: -1, dx: "150cqw", dy: "36cqh" }}>
        <g transform="rotate(14 30 6)">
          <path d="M0 6 L52 4 L52 8 Z" fill="#cfe4ff" opacity="0.35" />
          <path d="M30 6 L52 4.8 L52 7.2 Z" fill="#fff" opacity="0.6" />
          <polygon points={star5(4.6)} transform="translate(54 6)" fill="#fff6c8" />
        </g>
      </Act>
      {stars(16, 51)}
    </>
  );
};

const rocketLaunch: Art = u => {
  const [id, url] = ids(u);
  return (
    <>
      <Defs>
        <Lin id={id("hull")} c={["#ffffff", "#e6eaf4", "#b8c0d8"]} h />
        <Lin id={id("fire")} c={["#fff6c0", "#ffb347", "#ff5a36"]} />
        <Rad id={id("visor")} c={["#7fd0ff", "#3a5fb0", "#1c2a5a"]} />
        <Lin id={id("suit")} c={["#ffffff", "#dfe4f0"]} />
        <Rad id={id("moon")} c={["#d9f4ff", "#8fc8e8", "#4e7fa8"]} />
      </Defs>
      {stars(14, 61)}
      <Act p={{ r: -3, b: -3, w: 20 }} vb="-20 -20 40 40" c="fx-in" v={{ s0: 0.6, o0: 0, d: 1.2, in: 1.6 }}>
        <circle r="18" fill={url("moon")} stroke="#3e6a90" strokeWidth="0.8" />
        <circle cx="-6" cy="-4" r="3.6" fill="#6f9fc4" opacity="0.6" />
        <circle cx="5" cy="5" r="2.6" fill="#6f9fc4" opacity="0.6" />
        <circle cx="7" cy="-8" r="1.6" fill="#6f9fc4" opacity="0.5" />
      </Act>
      {range(7).map(i => (
        <Act key={i} p={{ l: f1(-4 + i * 4.2), b: f1(-5 + rnd(i, 71) * 7), w: f1(12 + rnd(i, 72) * 8) }} vb="-10 -10 20 20">
          <g className="fx-puff" style={vars({ it: f1(1.8 + rnd(i, 73)), id: f1(0.15 + i * 0.12) })}>
            <circle r="7" fill="#eef1f7" stroke="#c9d1e3" strokeWidth="0.6" />
            <circle cx="-4" cy="2" r="4.4" fill="#f7f8fc" />
            <circle cx="3" cy="-3" r="3" fill="#fff" />
          </g>
        </Act>
      ))}
      <Act p={{ l: 40, t: 34, w: 13, z: 3 }} vb="-16 -40 32 84" c="fx-once" v={{ x0: "-55cqw", y0: "72cqh", x1: "62cqw", y1: "-85cqh", in: 2.8, ease: "cubic-bezier(0.5, 0, 0.85, 0.6)" }}>
        <g transform="rotate(26)">
          <g className="pk pk-flicker" style={{ animationDuration: "0.35s" }}>
            <path d="M-7 15 C-8 26 -3 34 0 44 C3 34 8 26 7 15 Z" fill={url("fire")} />
            <path d="M-3.4 15 C-4 22 -1.4 27 0 32 C1.4 27 4 22 3.4 15 Z" fill="#fffbe0" />
          </g>
          <path d="M-10 2 L-18 18 L-9 15 Z M10 2 L18 18 L9 15 Z" fill="#e8453c" stroke="#8a1c1c" strokeWidth="0.9" strokeLinejoin="round" />
          <rect x="-6" y="12" width="12" height="5" rx="1.4" fill="#7a8199" stroke="#4a5578" strokeWidth="0.8" />
          <path d="M0 -34 C9 -24 11 -8 10 14 L-10 14 C-11 -8 -9 -24 0 -34 Z" fill={url("hull")} stroke="#4a5578" strokeWidth="1.1" />
          <path d="M0 -34 C5 -29 7.4 -24 8.6 -19 L-8.6 -19 C-7.4 -24 -5 -29 0 -34 Z" fill="#e8453c" stroke="#8a1c1c" strokeWidth="0.9" />
          <circle cy="-8" r="5" fill="#6fd0ff" stroke="#4a5578" strokeWidth="1.8" />
          <path d="M-2.6 -10 A3 3 0 0 1 0.6 -11.4" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" fill="none" />
          <path d="M0 2 L0 14" stroke="#e8453c" strokeWidth="2.4" />
          <path d="M-7 -16 C-8 -6 -8 4 -7.4 12" stroke="#fff" strokeWidth="1.4" fill="none" opacity="0.8" />
        </g>
      </Act>
      <Act p={{ r: 7, t: 10, w: 20, z: 2 }} vb="-22 -26 44 52" c="fx-in" v={{ x0: "40cqw", y0: "-12cqh", r0: "50deg", o0: 0, d: 2, in: 2.2 }}>
        <I c="fx-rock" v={{ amp: "3px", sw: "9deg", it: 3.6 }}>
          <rect x="-11" y="-4" width="22" height="16" rx="3" fill="#c9cfdf" stroke="#7a8199" strokeWidth="0.9" />
          <path d="M-8 2 C-14 -2 -18 -8 -17 -14" stroke="#7a8199" strokeWidth="6.4" strokeLinecap="round" fill="none" />
          <path d="M-8 2 C-14 -2 -18 -8 -17 -14" stroke={url("suit")} strokeWidth="4.8" strokeLinecap="round" fill="none" />
          <path d="M8 4 C13 6 16 10 17 15" stroke="#7a8199" strokeWidth="6.4" strokeLinecap="round" fill="none" />
          <path d="M8 4 C13 6 16 10 17 15" stroke={url("suit")} strokeWidth="4.8" strokeLinecap="round" fill="none" />
          <path d="M-4 14 L-6 24 M4 14 L6 24" stroke="#7a8199" strokeWidth="7" strokeLinecap="round" />
          <path d="M-4 14 L-6 24 M4 14 L6 24" stroke={url("suit")} strokeWidth="5.4" strokeLinecap="round" />
          <rect x="-9" y="-2" width="18" height="17" rx="5" fill={url("suit")} stroke="#7a8199" strokeWidth="1" />
          <rect x="-4.6" y="3" width="9.2" height="5.4" rx="1.4" fill="#dfe4f0" stroke="#7a8199" strokeWidth="0.6" />
          <circle cx="-2.2" cy="5.7" r="1" fill="#e8453c" />
          <circle cx="0.6" cy="5.7" r="1" fill="#57d28f" />
          <circle cx="3" cy="5.7" r="0.8" fill="#4fb0f5" />
          <circle cy="-12" r="11" fill={url("suit")} stroke="#7a8199" strokeWidth="1.1" />
          <ellipse cy="-11.4" rx="7.6" ry="6" fill={url("visor")} stroke="#4a5578" strokeWidth="0.8" />
          <path d="M-5 -14 A6 4.6 0 0 1 1 -16.4" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" fill="none" opacity="0.85" />
          <circle cx="3.6" cy="-9" r="0.9" fill="#fff" opacity="0.7" />
        </I>
      </Act>
    </>
  );
};

// ---------------------------------------------------------------- Elements

const thunderstorm: Art = u => {
  const [id, url] = ids(u);
  const bolt = (d: string) => (
    <>
      <path d={d} stroke="#9ad0ff" strokeWidth="10" strokeLinejoin="round" strokeLinecap="round" fill="none" opacity="0.22" />
      <path d={d} stroke="#ffe14d" strokeWidth="4.6" strokeLinejoin="round" strokeLinecap="round" fill="none" opacity="0.75" />
      <path d={d} stroke="#fffbe0" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" fill="none" />
    </>
  );
  const flash = { it: 5.2, id: 0.9 };
  return (
    <>
      <Defs>
        <Lin id={id("cloud")} c={["#7a86a8", "#4e5878", "#363e5c"]} />
        <Lin id={id("cloud2")} c={["#5d6888", "#2e3550"]} />
      </Defs>
      <div className="fx-layer fx-flash" style={{ background: "rgb(214 228 255 / 0.22)", opacity: 0, ...vars(flash) }} />
      <Act p={{ l: 16, t: 4, w: 12, z: 1 }} vb="0 0 24 64" c="fx-flash" v={flash}>
        {bolt("M14 0 L6 24 L13 25 L4 46 L10 46 L2 64")}
      </Act>
      <Act p={{ r: 22, t: 5, w: 8, z: 1 }} vb="0 0 20 50" c="fx-flash" v={{ it: 6.4, id: 2.6 }}>
        {bolt("M8 0 L14 18 L8 19 L15 36 L10 36 L16 50")}
      </Act>
      <Act p={{ l: 50, t: 6, w: 10, z: 1 }} vb="0 0 16 64" c="fx-flash" v={{ it: 4.4, id: 1.8 }}>
        {bolt("M12 0 L4 14 L10 18 L2 32 L9 36 L3 50 L10 64")}
      </Act>
      <Act p={{ l: -6, t: -2, w: 112, z: 2 }} vb="0 0 200 44" c="fx-in" v={{ y0: "-24cqw", in: 1.3 }}>
        <I c="fx-bob" v={{ amp: "1.2px", it: 4.6 }}>
          <path
            d="M-4 2 H204 V26 C200 34 190 36 182 32 C176 40 160 40 154 33 C146 41 128 41 120 33 C112 41 94 40 88 32 C80 40 62 40 56 32 C48 38 32 38 26 31 C18 37 2 36 -4 28 Z"
            fill={url("cloud2")}
          />
          <path
            d="M-4 0 H204 V20 C200 28 188 30 180 24 C174 32 156 32 150 24 C142 32 124 32 116 24 C108 31 92 31 86 23 C78 31 60 31 54 23 C46 29 30 29 24 22 C16 28 0 27 -4 20 Z"
            fill={url("cloud")}
            stroke="#2a3048"
            strokeWidth="0.9"
          />
          <path d="M8 20 C14 24 22 24 26 19 M58 21 C64 26 74 26 80 21 M120 22 C128 27 138 27 146 22 M164 21 C170 25 178 25 184 20" stroke="#9aa6c8" strokeWidth="1.4" fill="none" strokeLinecap="round" opacity="0.7" />
        </I>
      </Act>
      {range(18).map(i => {
        const tt = 0.9 + rnd(i, 82) * 0.6;
        return (
          <Act
            key={i}
            p={{ l: f1(4 + rnd(i, 81) * 100), t: 6, w: 1.4 }}
            vb="0 0 4 20"
            c="fx-travel"
            v={{ tt: f1(tt), td: f1(-rnd(i, 83) * tt), dx: "-12cqw", dy: "96cqh", op: 0.7 }}
          >
            <path d="M3.4 0 L0.8 18" stroke="#b8dcff" strokeWidth="1.3" strokeLinecap="round" />
          </Act>
        );
      })}
    </>
  );
};

/** A periodic wave strip 400 wide (period 50), crest line at `y`, height `amp`. */
const wave = (y: number, amp: number) =>
  `M0 ${y} Q12.5 ${y - amp} 25 ${y} ${range(15)
    .map(i => `T${50 + i * 25} ${y}`)
    .join(" ")} V40 H0 Z`;

const oceanWaves: Art = u => {
  const [id, url] = ids(u);
  const layer = (y: number, amp: number, fill: string, it: number, d: number, reverse?: boolean, foam?: boolean) => (
    <div className="fx-a fx-in" style={{ left: 0, bottom: 0, width: "200cqw", ...vars({ y0: "22cqw", d, in: 1.4 }) }}>
      <svg className="fx-slide" viewBox="0 0 400 40" style={{ display: "block", width: "100%", animationDirection: reverse ? "reverse" : undefined, ...vars({ it }) }}>
        <path d={wave(y, amp)} fill={fill} />
        {foam && (
          <>
            <path d={wave(y, amp).replace(/ V40 H0 Z$/, "")} stroke="#fff" strokeWidth="1.8" fill="none" opacity="0.9" />
            {range(16).map(i => (
              <circle key={i} cx={i * 25 + 12.5} cy={y + (i % 2 ? 4 : -2)} r="1" fill="#fff" opacity="0.8" />
            ))}
          </>
        )}
      </svg>
    </div>
  );
  return (
    <>
      <Defs>
        <Lin id={id("front")} c={["#8ee6f7", "#3aa6dc", "#2378b8"]} />
        <Lin id={id("mid")} c={["#4cb2e6", "#1f6fb0"]} />
        <Lin id={id("back")} c={["#2f80c4", "#174e8a"]} />
        <Lin id={id("sail")} c={["#ffffff", "#e3e8f2"]} h />
      </Defs>
      {layer(12, 7, url("back"), 16, 0)}
      <Act p={{ l: 16, b: "10cqw", w: 17, z: 0 }} vb="-16 -28 32 34" c="fx-in" v={{ x0: "-50cqw", o0: 0, d: 0.5, in: 2.4 }}>
        <I c="fx-rock" v={{ amp: "1.5px", sw: "6deg", it: 2.4 }}>
          <path d="M0 -26 L0 0" stroke="#6b4428" strokeWidth="1.4" />
          <path d="M1 -25 L1 -3 L13 -3 Z" fill={url("sail")} stroke="#9aa6c0" strokeWidth="0.7" strokeLinejoin="round" />
          <path d="M-1 -21 L-1 -3 L-11 -3 Z" fill="#ffd166" stroke="#c8962a" strokeWidth="0.7" strokeLinejoin="round" />
          <path d="M0 -26 L6 -24 L0 -22 Z" fill="#e8453c" />
          <path d="M-15 -1 L15 -1 L11 6 L-11 6 Z" fill="#c0503a" stroke="#7a2a1c" strokeWidth="0.8" strokeLinejoin="round" />
          <path d="M-13 1.6 L13 1.6" stroke="#ffd9c8" strokeWidth="0.8" />
        </I>
      </Act>
      {layer(20, 6, url("mid"), 11, 0.15, true)}
      {layer(28, 5, url("front"), 8, 0.3, false, true)}
      {[
        [12, 13, -3, 0.9],
        [20, 17, -10, 0.7],
      ].map(([t, tt, td, s], i) => (
        <Act key={i} p={{ l: -10, t: t!, w: f1(8 * s!) }} vb="-10 -5 20 10" c="fx-travel" v={{ tt: tt!, td: td!, dx: "125cqw", dy: "-5cqh", wx: "0px", wy: "2cqh" }}>
          <g className="fx-flap" style={vars({ it: 0.45, o: "50% 60%" })}>
            <path d="M-9 0 Q-4.6 -4.6 0 0 Q4.6 -4.6 9 0" stroke="#fdfdff" strokeWidth="1.8" fill="none" strokeLinecap="round" />
            <path d="M-9 0 L-7.4 -1.4 M9 0 L7.4 -1.4" stroke="#3a4262" strokeWidth="1.8" strokeLinecap="round" />
          </g>
        </Act>
      ))}
      {stars(5, 91, "#fff", [6, 72, 88, 18])}
    </>
  );
};

// ---------------------------------------------------------------- Party & Pals

const BALLOONS = ["#ff5c8a", "#ffc23d", "#4fb0f5", "#57d28f", "#b57cff"];

const balloon = (fill: string) => (
  <>
    <path d="M0 15 C-3 24 3 32 -1 40 C-3 46 1 52 0 58" stroke="#e8e8f0" strokeWidth="0.8" fill="none" />
    <path d="M0 -15 C8 -15 11 -8 11 -2 C11 7 4 13 0 14 C-4 13 -11 7 -11 -2 C-11 -8 -8 -15 0 -15 Z" fill={fill} stroke="rgb(0 0 0 / 0.25)" strokeWidth="0.8" />
    <path d="M-2.2 15.6 L2.2 15.6 L0 12.6 Z" fill={fill} stroke="rgb(0 0 0 / 0.25)" strokeWidth="0.6" strokeLinejoin="round" />
    <ellipse cx="-4.6" cy="-7" rx="2.4" ry="4" transform="rotate(20 -4.6 -7)" fill="#fff" opacity="0.6" />
    <path d="M6 4 C5 8 3 10.6 0.6 12" stroke="rgb(0 0 0 / 0.18)" strokeWidth="1.6" fill="none" strokeLinecap="round" />
  </>
);

const balloonParty: Art = u => {
  const [id, url] = ids(u);
  return (
    <>
      <Defs>
        {BALLOONS.map((c, i) => (
          <Rad key={c} id={id(`b${i}`)} c={["#ffffff", c, c]} cx={0.36} cy={0.3} r={0.8} />
        ))}
      </Defs>
      {[
        [4, 9, 11, 0, 3.2],
        [14, 2, 12.5, 1, 3.8],
        [25, 8, 10.5, 2, 2.9],
        [9, 22, 10, 3, 3.5],
        [20, 19, 9.5, 4, 3],
      ].map(([r, t, w, c, it], i) => (
        <Act key={i} p={{ r: r!, t: t!, w: w!, z: 2 }} vb="-12 -16 24 76" c="fx-in" v={{ y0: "115cqh", r0: `${(i % 2 ? 1 : -1) * 10}deg`, d: f1(i * 0.18), in: 2.2 }}>
          <I c="fx-rock" v={{ amp: "1.6px", sw: "5deg", it: it!, o: "50% 100%" }}>
            {balloon(url(`b${c}`))}
          </I>
        </Act>
      ))}
      {range(5).map(i => {
        const tt = 9 + rnd(i, 101) * 4;
        return (
          <Act
            key={`r${i}`}
            p={{ l: f1(4 + rnd(i, 102) * 60), t: 104, w: f1(6.5 + rnd(i, 103) * 2.5) }}
            vb="-12 -16 24 76"
            c="fx-travel"
            v={{ tt: f1(tt), td: f1(-rnd(i, 104) * tt), dx: `${f1((rnd(i, 105) - 0.5) * 20)}cqw`, dy: "-130cqh", wx: "4cqw", wy: "0px", rot: "0deg", op: 0.9 }}
          >
            {balloon(url(`b${i % BALLOONS.length}`))}
          </Act>
        );
      })}
      <div className="fx-layer fx-in" style={vars({ o0: 0, d: 0.6, in: 0.8 })}>
        {range(18).map(i => {
          const tt = 4.5 + rnd(i, 111) * 3;
          return (
            <Act
              key={i}
              p={{ l: f1(rnd(i, 112) * 96), t: -3, w: f1(1.6 + rnd(i, 113) * 1.2) }}
              vb="-2 -3 4 6"
              c="fx-travel"
              v={{ tt: f1(tt), td: f1(-rnd(i, 114) * tt), dx: `${f1((rnd(i, 115) - 0.5) * 18)}cqw`, dy: "104cqh", wx: "3cqw", wy: "0px", rot: `${Math.round(360 + rnd(i, 116) * 540)}deg` }}
            >
              <g className="fx-tumble" style={vars({ it: f1(0.35 + rnd(i, 117) * 0.4), o: "center" })}>
                {i % 3 ? <rect x="-1.6" y="-2.6" width="3.2" height="5.2" rx="0.4" fill={BALLOONS[i % 5]} /> : <circle r="1.8" fill={BALLOONS[(i + 2) % 5]} />}
              </g>
            </Act>
          );
        })}
      </div>
    </>
  );
};

const burst = (color: string, light: string) => (
  <>
    {range(14).map(i => {
      const a = (i / 14) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      return (
        <g key={i}>
          <path d={`M${f1(c * 12)} ${f1(s * 12)} L${f1(c * 37)} ${f1(s * 37)}`} stroke={color} strokeWidth="2.6" strokeLinecap="round" />
          <path d={`M${f1(c * 20)} ${f1(s * 20)} L${f1(c * 33)} ${f1(s * 33)}`} stroke={light} strokeWidth="1" strokeLinecap="round" />
          <circle cx={f1(c * 42)} cy={f1(s * 42)} r="2.4" fill={light} />
        </g>
      );
    })}
    {range(7).map(i => {
      const a = ((i + 0.5) / 7) * Math.PI * 2;
      return <circle key={`d${i}`} cx={f1(Math.cos(a) * 24)} cy={f1(Math.sin(a) * 24)} r="1.6" fill="#fff" />;
    })}
    <circle r="5" fill="#fff" opacity="0.9" />
  </>
);

const fireworks: Art = () => (
  <>
    {[
      [{ l: 4, t: 4, w: 36 }, "#ff5c9a", "#ffc0d8", 0],
      [{ r: 2, t: 2, w: 42 }, "#ffc23d", "#fff0b0", 0.9],
      [{ l: 32, t: 26, w: 28 }, "#4fe0ff", "#c8f6ff", 1.7],
      [{ r: 10, t: 40, w: 26 }, "#7dff9a", "#d8ffe0", 2.4],
      [{ l: 6, t: 50, w: 22 }, "#c08bff", "#ead8ff", 3],
    ].map(([p, color, light, d], i) => (
      <Act key={i} p={p as Place} vb="-50 -50 100 100">
        <g className="fx-burst" style={vars({ it: 3.6, id: d as number })}>
          {burst(color as string, light as string)}
        </g>
      </Act>
    ))}
    {range(5).map(i => (
      <Act key={`t${i}`} p={{ l: f1(10 + i * 18), t: 100, w: 1.6 }} vb="0 0 4 30" c="fx-travel" v={{ tt: 3.6, td: f1(-(rnd(i, 121) * 3.6)), dx: "0px", dy: `-${f1(50 + rnd(i, 122) * 30)}cqh`, op: 0.85 }}>
        <path d="M2 0 L2 26" stroke="#fff3c0" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="2 3" />
        <circle cx="2" cy="1" r="2" fill="#fff" />
      </Act>
    ))}
    {stars(10, 131, "#fff6c8")}
  </>
);

const peekabooCat: Art = u => {
  const [id, url] = ids(u);
  return (
    <>
      <Defs>
        <Rad id={id("fur")} c={["#ffd29a", "#f6a04e", "#e07d2c"]} cx={0.5} cy={0.35} r={0.7} />
        <Lin id={id("ear")} c={["#ffb870", "#e8843a"]} />
        <Rad id={id("yarn")} c={["#b8d0ff", "#6f98f5", "#3f62b8"]} />
      </Defs>
      <Act p={{ l: 9, b: -3, w: 10, z: 2 }} vb="0 0 30 72" c="fx-in" v={{ y0: "26cqw", d: 1.2, in: 1 }}>
        <I c="fx-sway" v={{ o: "50% 100%", sw: "16deg", it: 1.5 }}>
          <path d="M15 72 C15 52 4 46 6 30 C8 16 22 10 23 22" stroke="#8a4316" strokeWidth="9.6" strokeLinecap="round" fill="none" />
          <path d="M15 72 C15 52 4 46 6 30 C8 16 22 10 23 22" stroke="#f6a04e" strokeWidth="7" strokeLinecap="round" fill="none" />
          <path d="M15 72 C15 52 4 46 6 30 C8 16 22 10 23 22" stroke="#c8641f" strokeWidth="7" strokeDasharray="3 7" fill="none" />
        </I>
      </Act>
      <Act p={{ l: 26, b: 1, w: 10, z: 2 }} vb="-14 -12 28 24" c="fx-in" v={{ x0: "-45cqw", r0: "-600deg", d: 0.1, in: 1.7, ease: "cubic-bezier(0.2, 0.8, 0.3, 1)" }}>
        <path d="M-8 6 C-12 10 -16 8 -14 12" stroke="#3f62b8" strokeWidth="1" fill="none" />
        <circle r="10" fill={url("yarn")} stroke="#2f4f98" strokeWidth="0.9" />
        <path d="M-9 -3 C-3 -1 3 -7 7 -7 M-10 2 C-3 4 5 -2 10 -1 M-7 7 C-1 8 5 4 9 4 M-3 -9 C-5 -3 -4 4 -1 9 M3 -9 C1 -3 2 4 5 8" stroke="#dce8ff" strokeWidth="0.9" fill="none" opacity="0.8" />
      </Act>
      <Act p={{ r: 8, b: -2, w: 32, z: 3 }} vb="0 0 120 86" c="fx-in" v={{ y0: "32cqw", d: 0.4, in: 1.3, ease: "cubic-bezier(0.3, 1.5, 0.5, 1)" }}>
        <I c="fx-sway" v={{ o: "50% 100%", sw: "3deg", it: 3.4 }}>
          <path d="M26 32 L20 3 L48 18 Z" fill={url("ear")} stroke="#8a4316" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M28 26 L25 11 L40 19 Z" fill="#ffb0c0" />
          <g className="pk pk-twitch" style={{ transformOrigin: "40% 100%" }}>
            <path d="M94 32 L100 3 L72 18 Z" fill={url("ear")} stroke="#8a4316" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M92 26 L95 11 L80 19 Z" fill="#ffb0c0" />
          </g>
          <path d="M60 12 C86 12 104 28 104 52 C104 72 86 86 60 86 C34 86 16 72 16 52 C16 28 34 12 60 12 Z" fill={url("fur")} stroke="#8a4316" strokeWidth="1.6" />
          <path d="M60 15 L60 27 M50 17 L52.4 27 M70 17 L67.6 27" stroke="#c8641f" strokeWidth="3.2" strokeLinecap="round" />
          <path d="M17 46 L28 49 M17 55 L27 55 M103 46 L92 49 M103 55 L93 55" stroke="#c8641f" strokeWidth="2.6" strokeLinecap="round" />
          <ellipse cx="60" cy="63" rx="17" ry="11.5" fill="#fff4e8" />
          {[44, 76].map(x => (
            <g key={x}>
              <ellipse cx={x} cy="47" rx="6.8" ry="7.8" fill="#2a2a3a" />
              <ellipse cx={x} cy="48" rx="4.6" ry="5.8" fill="#4a8a3a" />
              <ellipse cx={x} cy="48" rx="2.4" ry="5" fill="#1a1a24" />
              <circle cx={x + 2.2} cy="44" r="2.2" fill="#fff" />
              <circle cx={x - 2} cy="51" r="1" fill="#fff" />
              <ellipse className="pk pk-blink" cx={x} cy="47" rx="7.6" ry="8.6" fill="#f6a04e" style={{ animationDuration: "4.2s" }} />
            </g>
          ))}
          <ellipse cx="33" cy="60" rx="5" ry="2.8" fill="#ff9ab0" opacity="0.55" />
          <ellipse cx="87" cy="60" rx="5" ry="2.8" fill="#ff9ab0" opacity="0.55" />
          <path d="M56 58 L64 58 L60 62.4 Z" fill="#ff8fa8" stroke="#c45a6e" strokeWidth="0.6" strokeLinejoin="round" />
          <path d="M60 62.4 Q57 67 52.6 65.4 M60 62.4 Q63 67 67.4 65.4" stroke="#8a4316" strokeWidth="1.3" fill="none" strokeLinecap="round" />
          <path d="M43 62 L24 58 M43 65.6 L23 67 M77 62 L96 58 M77 65.6 L97 67" stroke="#8a4316" strokeWidth="0.9" strokeLinecap="round" opacity="0.6" />
          {[40, 80].map(x => (
            <g key={x}>
              <ellipse cx={x} cy="81" rx="12.5" ry="7.5" fill={url("fur")} stroke="#8a4316" strokeWidth="1.4" />
              <path d={`M${x - 5} 78 L${x - 5} 84 M${x} 77 L${x} 84 M${x + 5} 78 L${x + 5} 84`} stroke="#8a4316" strokeWidth="1" strokeLinecap="round" />
            </g>
          ))}
        </I>
      </Act>
      {[
        [76, 3.8, -0.4],
        [84, 4.6, -2.2],
        [70, 5.2, -3.8],
      ].map(([l, tt, td], i) => (
        <Act key={i} p={{ l: l!, t: 72, w: 4 }} vb="-7 -7 14 14" c="fx-travel" v={{ tt: tt!, td: td!, dx: "0px", dy: "-34cqh", wx: "3cqw", wy: "0px", op: 0.9 }}>
          <path d={HEART} fill="#ff6f9c" stroke="#c43a68" strokeWidth="0.7" />
          <ellipse cx="-2.6" cy="-2.6" rx="1.4" ry="0.9" fill="#fff" opacity="0.7" />
        </Act>
      ))}
    </>
  );
};

/** Every scene, by effect id. */
export const SCENES: Record<string, Art> = {
  "sakura-breeze": sakuraBreeze,
  "autumn-canopy": autumnCanopy,
  "winter-wonderland": winterWonderland,
  "spooky-night": spookyNight,
  "jade-dragon": jadeDragon,
  "galaxy-swirl": galaxySwirl,
  "rocket-launch": rocketLaunch,
  thunderstorm,
  "ocean-waves": oceanWaves,
  "balloon-party": balloonParty,
  fireworks,
  "peekaboo-cat": peekabooCat,
};

