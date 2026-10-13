// Illustrated avatar decorations (ids in perks/catalog.ts AVATAR_DECORATIONS with `art: true`). Each draws in the decoration's
// 100 x 100 box, where the avatar is the circle at (50, 50) with radius 40; art keeps to the rim and leaves the face's centre clear.
import { Blossom, Glow, LEAF, Leaf, Lin, Maple, Rad, Sparkle, anim, ids, star5, type Art } from "./shared";

/** A point on a circle around the avatar's centre; angles in degrees, 0 = right, 90 = down. */
const rim = (deg: number, r = 41): [number, number] => [50 + Math.cos((deg * Math.PI) / 180) * r, 50 + Math.sin((deg * Math.PI) / 180) * r];
const MIRROR = "translate(100 0) scale(-1 1)";

const catEars: Art = u => {
  const [id, url] = ids(u);
  const ear = (
    <>
      <path d="M12 35 Q6 15 16.5 2.5 Q31 6.5 43 14 Q24 16.5 12 35 Z" fill={url("f")} stroke="#8f4313" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M17 28.5 Q14 15.5 19.5 8.5 Q29.5 11 36 15.2 Q24 18 17 28.5 Z" fill={url("p")} />
      <path d="M19.5 25 L22.5 18.5 M23 25.5 L26 19.5 M26.5 22.5 L28.2 18.4" stroke="#fff" strokeWidth="1" strokeLinecap="round" opacity="0.9" />
      <path d="M23 5.5 Q25 8.5 24 11 M28.5 8 Q30 10.4 29 12.5 M33.5 10.5 Q34.6 12.3 33.8 14" stroke="#c55a19" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <path d="M13.8 20 Q13 11 16.8 5.4" stroke="#fff" strokeOpacity="0.6" strokeWidth="1.2" fill="none" strokeLinecap="round" />
    </>
  );
  return (
    <>
      <defs>
        <Lin id={id("f")} c={["#ffc27a", "#f28d3c", "#dc6a26"]} />
        <Lin id={id("p")} c={["#ffd9e3", "#f598b4"]} />
      </defs>
      {ear}
      <g transform={MIRROR}>
        <g className="pk pk-twitch" style={anim(0, 5, "50% 75%")}>
          {ear}
        </g>
      </g>
    </>
  );
};

const bunnyEars: Art = u => {
  const [id, url] = ids(u);
  const ear = (inner: string) => (
    <>
      <ellipse cx="0" cy="-13" rx="7.4" ry="15" fill={url("f")} stroke="#a796a8" strokeWidth="1.1" />
      <ellipse cx="0.4" cy="-11.5" rx="3.6" ry="11" fill={inner} />
      <path d="M-4.6 -22 Q-5.4 -14 -4 -6" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" fill="none" opacity="0.9" />
    </>
  );
  return (
    <>
      <defs>
        <Lin id={id("f")} c={["#ffffff", "#f1e8f0", "#ded0dc"]} />
        <Lin id={id("p")} c={["#ffd0de", "#f48fb1"]} />
        <Rad id={id("b")} c={["#ffb3d0", "#f0609a"]} />
      </defs>
      <g transform="translate(35 20) rotate(-17)">{ear(url("p"))}</g>
      <g transform="translate(65 20) rotate(24)">
        <g className="pk pk-sway" style={anim(0.4, 4.2)}>
          {ear(url("p"))}
        </g>
      </g>
      {/* a bow at the left ear */}
      <g transform="translate(42 16.5) rotate(-14)">
        <path d="M0 0 L-7.5 -4.4 Q-9.2 0 -7.5 4.4 Z" fill={url("b")} stroke="#b0336c" strokeWidth="0.9" strokeLinejoin="round" />
        <path d="M0 0 L7.5 -4.4 Q9.2 0 7.5 4.4 Z" fill={url("b")} stroke="#b0336c" strokeWidth="0.9" strokeLinejoin="round" />
        <path d="M-6 -2.4 L-3 -0.8 M6 -2.4 L3 -0.8" stroke="#fff" strokeWidth="0.8" strokeLinecap="round" opacity="0.7" />
        <circle r="2.2" fill="#ff8fbd" stroke="#b0336c" strokeWidth="0.9" />
      </g>
    </>
  );
};

const frogFriend: Art = u => {
  const [id, url] = ids(u);
  const eye = (x: number) => (
    <g transform={`translate(${x} -15)`}>
      <circle r="4.6" fill={url("b")} stroke="#24652f" strokeWidth="0.9" />
      <circle r="3.1" fill="#fff" />
      <circle cx="0.5" cy="0.3" r="1.8" fill="#1d2a1f" />
      <circle cx="1.1" cy="-0.4" r="0.6" fill="#fff" />
    </g>
  );
  return (
    <>
      <defs>
        <Rad id={id("b")} c={["#b8f27a", "#6cc94f", "#349445"]} />
        <Lin id={id("l")} c={["#f6ffd0", "#d7f29a"]} />
        <Rad id={id("pad")} c={["#7fd17a", "#2f8a45"]} />
      </defs>
      <g transform={`translate(${rim(-48, 41).join(" ")}) rotate(42)`}>
        <g className="pk pk-bob" style={anim(0, 3.4)}>
          <ellipse cx="-9.5" cy="-2" rx="5.2" ry="3.4" fill={url("b")} stroke="#24652f" strokeWidth="0.9" />
          <ellipse cx="9.5" cy="-2" rx="5.2" ry="3.4" fill={url("b")} stroke="#24652f" strokeWidth="0.9" />
          <ellipse cx="0" cy="-7" rx="11" ry="8.2" fill={url("b")} stroke="#24652f" strokeWidth="1" />
          <ellipse cx="0" cy="-4" rx="6.8" ry="4.2" fill={url("l")} />
          {eye(-6)}
          {eye(6)}
          <path d="M-4.4 -9.2 Q0 -6.2 4.4 -9.2" stroke="#1f5a2a" strokeWidth="0.9" fill="none" strokeLinecap="round" />
          <ellipse cx="-7.4" cy="-9" rx="1.7" ry="1" fill="#ff8fa8" opacity="0.7" />
          <ellipse cx="7.4" cy="-9" rx="1.7" ry="1" fill="#ff8fa8" opacity="0.7" />
          <ellipse cx="-4" cy="-0.4" rx="2.6" ry="1.4" fill={url("b")} stroke="#24652f" strokeWidth="0.8" />
          <ellipse cx="4" cy="-0.4" rx="2.6" ry="1.4" fill={url("b")} stroke="#24652f" strokeWidth="0.8" />
          <path d="M-8 -12 Q-6 -14 -3 -13.5" stroke="#fff" strokeWidth="0.8" opacity="0.6" fill="none" strokeLinecap="round" />
        </g>
      </g>
      <Sparkle x={86} y={8} r={2.6} fill="#e9ffc4" d={0.6} />
    </>
  );
};

const autumnLeaves: Art = u => {
  const [id, url] = ids(u);
  const fills = [url("r"), url("o"), url("y"), url("o"), url("r"), url("y")];
  const edges = ["#8a1d12", "#a2470e", "#a77a0e", "#a2470e", "#8a1d12", "#a77a0e"];
  return (
    <>
      <defs>
        <Rad id={id("r")} c={["#ff8a5c", "#e8452c", "#b8261a"]} />
        <Rad id={id("o")} c={["#ffc46b", "#f39a2b", "#d96a14"]} />
        <Rad id={id("y")} c={["#fff09a", "#f7c948", "#e09b1c"]} />
        <Lin id={id("nut")} c={["#e9b46a", "#b7752d"]} />
        <Lin id={id("cap")} c={["#9a6a3c", "#5e3c1e"]} />
      </defs>
      {[110, 128, 146, 164, 182, 200].map((deg, i) => {
        const [x, y] = rim(deg, 42);
        const leaf = <Maple x={0} y={0} s={i % 2 ? 1.05 : 1.25} r={0} fill={fills[i]} edge={edges[i]} />;
        return (
          <g key={deg} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${deg - 90 + (i % 2 ? 25 : -20)})`}>
            {i === 2 || i === 5 ? (
              <g className="pk pk-sway" style={anim(i * 0.5, 3.8, "50% 90%")}>
                {leaf}
              </g>
            ) : (
              leaf
            )}
          </g>
        );
      })}
      {/* an acorn tucked in the garland */}
      <g transform={`translate(${rim(156, 46).map(v => v.toFixed(1)).join(" ")}) rotate(30)`}>
        <path d="M-3.4 0 Q-3.7 5 0 7.2 Q3.7 5 3.4 0 Z" fill={url("nut")} stroke="#7a4a18" strokeWidth="0.7" />
        <path d="M-4.3 0.6 Q-4.5 -3.6 0 -3.9 Q4.5 -3.6 4.3 0.6 Q0 1.7 -4.3 0.6 Z" fill={url("cap")} stroke="#3e2610" strokeWidth="0.7" />
        <path d="M0 -3.9 L0.8 -5.8" stroke="#3e2610" strokeWidth="1" strokeLinecap="round" />
        <path d="M-2 1.6 Q-2.2 4 -0.6 5.4" stroke="#fff" strokeWidth="0.6" opacity="0.5" fill="none" />
      </g>
      {[-38, -56].map((deg, i) => {
        const [x, y] = rim(deg, 43);
        return <Maple key={deg} x={x} y={y} s={i ? 0.95 : 1.15} r={deg + 90 + (i ? -30 : 20)} fill={i ? url("y") : url("r")} edge={i ? "#a77a0e" : "#8a1d12"} />;
      })}
    </>
  );
};

const flowerCrown: Art = u => {
  const [id, url] = ids(u);
  const flower = (x: number, y: number, s: number, petals: string, edge: string, rot: number) => (
    <g key={`${x}-${y}`} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot}) scale(${s})`}>
      {[0, 72, 144, 216, 288].map(a => (
        <ellipse key={a} cx="0" cy="-3.5" rx="2.7" ry="3.6" transform={`rotate(${a})`} fill={petals} stroke={edge} strokeWidth="0.5" />
      ))}
      <circle r="2" fill={url("c")} stroke="#c7861a" strokeWidth="0.5" />
      <circle cx="-0.6" cy="-0.6" r="0.6" fill="#fff" opacity="0.8" />
    </g>
  );
  const blooms: [number, number, string, string][] = [
    [-160, 0.75, url("w"), "#b9a9c9"],
    [-138, 0.95, url("k"), "#d0608e"],
    [-115, 0.85, url("l"), "#8a6cc4"],
    [-90, 1.15, url("k"), "#d0608e"],
    [-65, 0.85, url("p"), "#d98a4a"],
    [-42, 0.95, url("w"), "#b9a9c9"],
    [-20, 0.75, url("l"), "#8a6cc4"],
  ];
  return (
    <>
      <defs>
        <Rad id={id("k")} c={["#ffe1ee", "#ff9cc6", "#f06fa6"]} cx={0.5} cy={0.9} />
        <Rad id={id("w")} c={["#ffffff", "#f3eefc", "#d9cff0"]} cx={0.5} cy={0.9} />
        <Rad id={id("l")} c={["#efe2ff", "#c4a6ff", "#9b77eb"]} cx={0.5} cy={0.9} />
        <Rad id={id("p")} c={["#fff1de", "#ffc58f", "#f59a55"]} cx={0.5} cy={0.9} />
        <Rad id={id("c")} c={["#fff2a8", "#f5c542"]} />
        <Lin id={id("g")} c={["#9be27a", "#4ea14a"]} />
      </defs>
      {[-150, -127, -103, -77, -53, -30].map((deg, i) => {
        const [x, y] = rim(deg, 41);
        return <Leaf key={deg} x={x} y={y} s={0.7} r={deg + (i % 2 ? -50 : 130)} fill={url("g")} edge="#2f7a35" />;
      })}
      {blooms.map(([deg, s, fill, edge], i) => {
        const [x, y] = rim(deg, 41);
        return flower(x, y, s, fill, edge, i * 17);
      })}
      {[-149, -103, -53].map((deg, i) => {
        const [x, y] = rim(deg, 46);
        return <circle key={deg} cx={x} cy={y} r="1.1" fill="#fff" className="pk pk-twinkle" style={anim(i * 0.7)} />;
      })}
    </>
  );
};

const sakuraBranch: Art = u => {
  const [id, url] = ids(u);
  return (
    <>
      <defs>
        <Lin id={id("br")} c={["#7a4a3a", "#4a2a22"]} />
        <Rad id={id("p")} c={["#ffffff", "#ffd2e1", "#f59bbb"]} cx={0.5} cy={0.95} r={0.9} />
      </defs>
      <path d="M101 46 C96 30 86 16 70 8 C60 3 50 2 41 5.5" stroke={url("br")} strokeWidth="3.4" strokeLinecap="round" fill="none" />
      <path d="M85 16 C87 10 90 6.5 95 5" stroke={url("br")} strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <path d="M62 4.5 C60 1 57 -1 53 -2" stroke={url("br")} strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <path d="M95 32 C99 30 102 27 103 23" stroke={url("br")} strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <path d="M99 40 C97 32 90 20 76 11" stroke="#a77a66" strokeWidth="0.7" strokeLinecap="round" fill="none" opacity="0.6" />
      <Leaf x={88} y={13} s={0.55} r={-60} fill="#7fcf6b" edge="#3c8a3a" />
      <Blossom x={95} y={5.5} s={0.95} r={10} fill={url("p")} />
      <Blossom x={74} y={9.5} s={1.15} r={-20} fill={url("p")} />
      <Blossom x={92} y={28} s={1} r={30} fill={url("p")} />
      <Blossom x={56} y={1} s={0.75} r={5} fill={url("p")} />
      <Blossom x={103} y={22} s={0.7} r={-10} fill={url("p")} />
      <ellipse cx="43" cy="4" rx="2" ry="2.6" transform="rotate(-60 43 4)" fill="#f59bbb" stroke="#d9668f" strokeWidth="0.45" />
      <ellipse cx="83" cy="20" rx="1.8" ry="2.4" transform="rotate(30 83 20)" fill="#f59bbb" stroke="#d9668f" strokeWidth="0.45" />
      {[
        [86, 34, 0],
        [66, 16, 1.6],
      ].map(([x, y, d]) => (
        <g key={x} transform={`translate(${x} ${y})`}>
          <path className="pk pk-fall" style={anim(d, 4.6)} d="M0 0 C-2 -1 -2.3 -3.8 -0.8 -4.6 L0 -3.9 L0.8 -4.6 C2.3 -3.8 2 -1 0 0 Z" fill={url("p")} stroke="#d9668f" strokeWidth="0.4" />
        </g>
      ))}
    </>
  );
};

const mushrooms: Art = u => {
  const [id, url] = ids(u);
  return (
    <>
      <defs>
        <Rad id={id("cap")} c={["#ff8a7a", "#e53935", "#a3161c"]} cx={0.4} cy={0.25} />
        <Rad id={id("tan")} c={["#f5c99a", "#d58a4a", "#9a5524"]} cx={0.4} cy={0.25} />
        <Lin id={id("st")} c={["#fffaf0", "#e9dcc4"]} />
        <Lin id={id("gr")} c={["#8fdc6a", "#3d9a45"]} />
        <Glow id={id("fly")} color="#fff59a" opacity={0.9} />
      </defs>
      <g transform="translate(20 94) scale(1.25) translate(-20 -94)">
      {/* grass behind */}
      <path d="M4 90 Q6 82 5 76 Q8 83 9 88 Q10 80 13 75 Q12 84 13 90 Z" fill={url("gr")} />
      {/* big toadstool */}
      <path d="M14.5 94 Q13.6 85 16.2 78.5 L23.5 78.5 Q25.6 85 25 94 Q20 96 14.5 94 Z" fill={url("st")} stroke="#b4a184" strokeWidth="0.9" />
      <path d="M16 84 Q20 86 24.3 84" stroke="#d9c8aa" strokeWidth="0.8" fill="none" />
      <g transform="rotate(-10 20 78)">
        <ellipse cx="20" cy="79.6" rx="11.5" ry="2.6" fill="#f1e4ce" stroke="#b4a184" strokeWidth="0.7" />
        <path d="M7.2 79.5 C7 67.5 33 66 33 79.5 Q20 82.5 7.2 79.5 Z" fill={url("cap")} stroke="#7a1015" strokeWidth="1" strokeLinejoin="round" />
        <ellipse cx="14.5" cy="73" rx="2.4" ry="1.8" fill="#fff" />
        <ellipse cx="22" cy="70.4" rx="2.8" ry="1.9" fill="#fff" />
        <ellipse cx="28.4" cy="75" rx="1.8" ry="1.5" fill="#fff" />
        <ellipse cx="11" cy="77.4" rx="1.3" ry="1" fill="#fff" />
        <ellipse cx="19.5" cy="76" rx="1.5" ry="1.1" fill="#fff" />
        <path d="M10 74 Q12 69.5 17 68.3" stroke="#fff" strokeWidth="1" opacity="0.45" fill="none" strokeLinecap="round" />
      </g>
      {/* small brown mushroom */}
      <path d="M31 96 Q30.6 91 31.6 88 L35 88 Q36 91 35.6 96 Z" fill={url("st")} stroke="#b4a184" strokeWidth="0.7" />
      <path d="M27 88.6 C27 82 39.6 81.4 39.6 88.6 Q33.3 90.2 27 88.6 Z" fill={url("tan")} stroke="#6e3a14" strokeWidth="0.8" />
      <path d="M29.4 85.4 Q31 83.4 33.6 83" stroke="#fff" strokeWidth="0.8" opacity="0.5" fill="none" strokeLinecap="round" />
      {/* grass in front */}
      <path d="M10 97 Q11 91 9.5 86 Q13 91 14 95 Q15.5 89 18.5 86 Q17 92 18 97 Z" fill={url("gr")} />
      <path d="M26 98 Q27 93 25.5 89.5 Q29 93 29.6 97 Q31 93.5 33 91.5 Q32 95 32.6 98.5 Z" fill={url("gr")} />
      <circle cx="36" cy="74" r="4" fill={url("fly")} className="pk pk-pulse" style={anim(0, 2.2)} />
      <circle cx="36" cy="74" r="0.9" fill="#fffbd1" />
      <circle cx="6" cy="68" r="3" fill={url("fly")} className="pk pk-pulse" style={anim(1.1, 2.6)} />
      <circle cx="6" cy="68" r="0.7" fill="#fffbd1" />
      </g>
    </>
  );
};

const sprout: Art = u => {
  const [id, url] = ids(u);
  return (
    <>
      <defs>
        <Lin id={id("l")} c={["#b6f27c", "#4caf50"]} />
        <Rad id={id("bug")} c={["#ff8a80", "#e53935", "#a31515"]} />
      </defs>
      <g transform="translate(50 13) scale(1.45) translate(-50 -13)">
      <g className="pk pk-sway" style={anim(0, 4, "50% 100%")}>
        <path d="M50 13 C50 8 49 5 50.5 0.5" stroke="#5aa845" strokeWidth="1.9" strokeLinecap="round" fill="none" />
        <g transform="translate(50.2 3) rotate(-160)">
          <path d={LEAF} fill={url("l")} stroke="#2f7a35" strokeWidth="0.7" strokeLinejoin="round" transform="scale(1.05)" />
          <path d="M1 0 Q6 -0.5 11.5 0" stroke="#2f7a35" strokeWidth="0.5" fill="none" opacity="0.6" />
        </g>
        <g transform="translate(50.6 1.5) rotate(-25)">
          <path d={LEAF} fill={url("l")} stroke="#2f7a35" strokeWidth="0.7" strokeLinejoin="round" transform="scale(1.2)" />
          <path d="M1 0 Q7 -0.5 13.5 0" stroke="#2f7a35" strokeWidth="0.5" fill="none" opacity="0.6" />
          {/* ladybird */}
          <g transform="translate(9 -0.6) rotate(20)">
            <ellipse rx="2.4" ry="2" fill={url("bug")} stroke="#5a0b0b" strokeWidth="0.4" />
            <path d="M0 -2 L0 2" stroke="#3a0808" strokeWidth="0.35" />
            <circle cx="-1" cy="-0.4" r="0.45" fill="#2a0606" />
            <circle cx="1" cy="0.6" r="0.45" fill="#2a0606" />
            <circle cx="2.3" cy="0" r="0.9" fill="#222" />
          </g>
        </g>
        <ellipse cx="45" cy="-1" rx="0.9" ry="1.2" fill="#d6f3ff" opacity="0.9" />
      </g>
      </g>
    </>
  );
};

const royalCrown: Art = u => {
  const [id, url] = ids(u);
  return (
    <>
      <defs>
        <Lin id={id("g")} c={["#fff5b8", "#f8cf4a", "#d9971c"]} />
        <Lin id={id("b")} c={["#f2b734", "#b97810"]} />
        <Rad id={id("r")} c={["#ff9aa8", "#e0233f", "#8f0f22"]} />
        <Rad id={id("s")} c={["#a9e6ff", "#2f8ee0", "#1a4f9a"]} />
        <Rad id={id("pearl")} c={["#ffffff", "#f6eefc", "#d6c6e6"]} />
      </defs>
      <g transform="rotate(-8 50 16)">
        <path d="M31 22 L28.6 5 L39.5 12.6 L50 0.5 L60.5 12.6 L71.4 5 L69 22 Q50 26 31 22 Z" fill={url("g")} stroke="#8a5a10" strokeWidth="1.1" strokeLinejoin="round" />
        <path d="M30.5 17.4 Q50 21.4 69.5 17.4 L69 22 Q50 26 31 22 Z" fill={url("b")} stroke="#8a5a10" strokeWidth="1" strokeLinejoin="round" />
        <path d="M32.5 8.6 L33.6 16.5 M48.6 5 L48.2 14.5" stroke="#fff" strokeWidth="1.1" opacity="0.6" strokeLinecap="round" />
        <polygon points="50,7.4 52.3,10.6 50,13.8 47.7,10.6" fill={url("s")} stroke="#123a70" strokeWidth="0.6" />
        <ellipse cx="50" cy="21" rx="3.1" ry="2.3" fill={url("r")} stroke="#5e0a17" strokeWidth="0.6" />
        <circle cx="39.5" cy="20" r="1.7" fill={url("s")} stroke="#123a70" strokeWidth="0.5" />
        <circle cx="60.5" cy="20" r="1.7" fill={url("s")} stroke="#123a70" strokeWidth="0.5" />
        <circle cx="49.2" cy="20.2" r="0.8" fill="#fff" opacity="0.85" />
        {[
          [28.6, 5],
          [50, 0.5],
          [71.4, 5],
        ].map(([x, y]) => (
          <circle key={x} cx={x} cy={y} r="2.3" fill={url("pearl")} stroke="#8a5a10" strokeWidth="0.7" />
        ))}
      </g>
      <Sparkle x={22} y={4} r={3} fill="#fff8d0" />
      <Sparkle x={79} y={10} r={2.4} fill="#fff8d0" d={0.9} />
      <Sparkle x={60} y={-3} r={2} fill="#fff" d={1.7} />
    </>
  );
};

const devilHorns: Art = u => {
  const [id, url] = ids(u);
  const horn = (
    <>
      <ellipse cx="27" cy="12" rx="11" ry="12" fill={url("glow")} className="pk pk-pulse" style={anim(0, 2.6)} />
      <path d="M24.5 21.5 C18.5 15.5 15 7 17.8 -1.5 C23 4.5 31.5 7.5 38 12.6 Z" fill={url("h")} stroke="#5e0716" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M21.3 14.3 Q24.6 12.4 27 15.2 M19.4 8.8 Q22 7.4 24.2 9.6 M18.4 3.6 Q20.4 2.8 21.8 4.4" stroke="#7d0a1e" strokeWidth="0.8" fill="none" strokeLinecap="round" />
      <path d="M19.8 1.4 Q19.4 9 23.4 15.6" stroke="#ffc2c2" strokeWidth="1" opacity="0.75" fill="none" strokeLinecap="round" />
    </>
  );
  return (
    <>
      <defs>
        <Lin id={id("h")} c={["#ff7a7a", "#e3243b", "#9e0e26"]} />
        <Glow id={id("glow")} color="#ff3b3b" opacity={0.45} />
      </defs>
      {horn}
      <g transform={MIRROR}>{horn}</g>
    </>
  );
};

const angelWings: Art = u => {
  const [id, url] = ids(u);
  const WING = "M0 0 C-1 -10 -6 -22 -15 -30 C-14.5 -24 -16.5 -20 -19 -17 C-15.5 -16.5 -14 -14 -15.5 -10 C-12 -10 -10.5 -7.5 -11.5 -4 C-8.5 -4.4 -6.5 -2.4 -7 0.6 C-4.6 -0.6 -2 0.4 0 0 Z";
  const wing = (
    <g transform="translate(15 52)">
      <g className="pk pk-sway" style={anim(0, 3.2, "100% 100%")}>
        <path d={WING} transform="translate(1 1) scale(1.08)" fill="#c9d4ee" stroke="#8494b8" strokeWidth="0.8" strokeLinejoin="round" />
        <path d={WING} fill={url("w")} stroke="#8494b8" strokeWidth="0.9" strokeLinejoin="round" />
        <path d="M-2.5 -4 Q-8 -8 -13.5 -11 M-2 -9 Q-8 -14 -15 -17.5 M-2 -14 Q-6 -20 -12 -25" stroke="#a9b6d6" strokeWidth="0.7" fill="none" strokeLinecap="round" />
        <path d="M-1.6 -6 C-2.4 -14 -6 -21 -11 -26" stroke="#fff" strokeWidth="1" fill="none" strokeLinecap="round" opacity="0.9" />
      </g>
    </g>
  );
  return (
    <>
      <defs>
        <Lin id={id("w")} c={["#ffffff", "#eef3ff", "#d3dcf2"]} />
        <Lin id={id("h")} c={["#fff6c2", "#f7c948", "#e0a018"]} />
      </defs>
      {wing}
      <g transform={MIRROR}>{wing}</g>
      <g className="pk pk-bob" style={anim(0, 3)}>
        <ellipse cx="50" cy="5" rx="16" ry="4.2" fill="none" stroke="#b9800f" strokeWidth="3.6" />
        <ellipse cx="50" cy="5" rx="16" ry="4.2" fill="none" stroke={url("h")} strokeWidth="2.4" />
        <path d="M38 3 Q50 -0.4 62 3" stroke="#fffbe0" strokeWidth="0.8" fill="none" strokeLinecap="round" />
      </g>
    </>
  );
};

const starHalo: Art = u => {
  const [id, url] = ids(u);
  const stars: [number, number, number][] = [
    [200, 4.4, 0],
    [245, 3.4, 0.5],
    [290, 3.6, 1],
    [335, 4.4, 1.5],
    [25, 5.6, 0.8],
    [130, 5.2, 1.8],
  ];
  return (
    <>
      <defs>
        <Rad id={id("s")} c={["#fffbe0", "#ffd84a", "#f0a51c"]} />
        <Rad id={id("m")} c={["#fff8dc", "#ffe08a", "#e2b44a"]} />
      </defs>
      <ellipse cx="50" cy="9" rx="31" ry="8" fill="none" stroke="#ffe08a" strokeWidth="0.7" strokeDasharray="1.5 2.5" opacity="0.6" />
      {stars.map(([deg, r, d]) => {
        const a = (deg * Math.PI) / 180;
        const x = 50 + Math.cos(a) * 31;
        const y = 9 + Math.sin(a) * 8;
        return (
          <g key={deg} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${deg % 30})`}>
            <g className="pk pk-twinkle" style={anim(d, 3)}>
              <polygon points={star5(r)} fill={url("s")} stroke="#b9780c" strokeWidth="0.6" strokeLinejoin="round" />
              <circle cx={-r * 0.2} cy={-r * 0.25} r={r * 0.18} fill="#fff" opacity="0.9" />
            </g>
          </g>
        );
      })}
      {/* a crescent moon at the front left */}
      <g transform="translate(23 16) rotate(-20) scale(1.3)">
        <path d="M0 -4.6 A4.6 4.6 0 1 0 3.4 3.1 A3.6 3.6 0 1 1 0 -4.6 Z" fill={url("m")} stroke="#b9780c" strokeWidth="0.6" strokeLinejoin="round" />
      </g>
      <Sparkle x={66} y={0} r={1.6} d={1.2} />
      <Sparkle x={36} y={1} r={1.3} d={0.3} />
    </>
  );
};

const witchHat: Art = u => {
  const [id, url] = ids(u);
  return (
    <>
      <defs>
        <Lin id={id("c")} c={["#9d6bff", "#6a3fd6", "#41208f"]} h />
        <Lin id={id("br")} c={["#7a4ee6", "#3a1b80"]} />
        <Lin id={id("band")} c={["#ffb35c", "#f07c1e"]} />
        <Lin id={id("gold")} c={["#fff2a8", "#f2b632"]} />
      </defs>
      <g transform="rotate(-10 46 21)">
        <ellipse cx="46" cy="21.5" rx="31" ry="7.4" fill={url("br")} stroke="#22104a" strokeWidth="1.1" />
        <path d="M17 22 Q46 30 75 22" stroke="#a98bff" strokeWidth="0.9" fill="none" opacity="0.55" strokeLinecap="round" />
        <path d="M30 19.5 C33.5 9.5 38 1 47 -4.4 C53 -7.8 61.5 -7 66.5 -1.8 C60.5 -3 56.5 -1.2 55.4 3 C56.2 9 58.4 14 62 18 Q46 23 30 19.5 Z" fill={url("c")} stroke="#22104a" strokeWidth="1.1" strokeLinejoin="round" />
        <path d="M31.3 15.6 Q46 19.4 60.4 14.2 L62 18 Q46 23 30 19.5 Z" fill={url("band")} stroke="#9a4a0e" strokeWidth="0.8" strokeLinejoin="round" />
        <rect x="42.4" y="14.6" width="7.2" height="5.8" rx="1" fill="none" stroke={url("gold")} strokeWidth="1.5" />
        <path d="M35 14 C37 7 40.5 1.5 46 -2.4" stroke="#c9b0ff" strokeWidth="1.1" opacity="0.65" fill="none" strokeLinecap="round" />
        <circle cx="52" cy="6" r="0.8" fill="#fff3b0" />
        <circle cx="40" cy="9" r="0.6" fill="#fff3b0" />
      </g>
      {/* a little star charm hanging from the tip */}
      <g transform="translate(65.6 -2.6)">
        <g className="pk pk-sway" style={anim(0, 2.8, "50% 0")}>
          <path d="M0 0 L0 7" stroke="#e6d6ff" strokeWidth="0.5" />
          <g transform="translate(0 9.4)">
            <polygon points={star5(3)} fill={url("gold")} stroke="#a8740f" strokeWidth="0.5" strokeLinejoin="round" />
          </g>
        </g>
      </g>
      <Sparkle x={80} y={22} r={2} fill="#e6d6ff" d={0.7} />
    </>
  );
};

const pumpkins: Art = u => {
  const [id, url] = ids(u);
  const pumpkin = (x: number, y: number, w: number, h: number, flicker: number) => (
    <g transform={`translate(${x} ${y})`}>
      <path d={`M-1.2 ${-h + 1.2} Q-1.6 ${-h - 3} 1.6 ${-h - 4.6} L2.6 ${-h - 3.2} Q0.9 ${-h - 2} 1.4 ${-h + 1.2} Z`} fill="#6b8e23" stroke="#3d5a12" strokeWidth="0.6" />
      <ellipse cx={-w * 0.45} cy="0" rx={w * 0.55} ry={h} fill={url("p")} stroke="#a3420f" strokeWidth="0.8" />
      <ellipse cx={w * 0.45} cy="0" rx={w * 0.55} ry={h} fill={url("p")} stroke="#a3420f" strokeWidth="0.8" />
      <ellipse cx="0" cy="0" rx={w * 0.5} ry={h * 1.03} fill={url("p")} stroke="#a3420f" strokeWidth="0.8" />
      <g className="pk pk-flicker" style={anim(flicker)} fill={url("face")}>
        <polygon points={`${-w * 0.42},${-h * 0.15} ${-w * 0.18},${-h * 0.15} ${-w * 0.3},${-h * 0.5}`} />
        <polygon points={`${w * 0.42},${-h * 0.15} ${w * 0.18},${-h * 0.15} ${w * 0.3},${-h * 0.5}`} />
        <path d={`M${-w * 0.5} ${h * 0.15} Q0 ${h * 0.75} ${w * 0.5} ${h * 0.15} L${w * 0.3} ${h * 0.28} L${w * 0.15} ${h * 0.15} L0 ${h * 0.32} L${-w * 0.15} ${h * 0.15} L${-w * 0.3} ${h * 0.28} Z`} />
      </g>
      <path d={`M${-w * 0.75} ${-h * 0.45} Q${-w * 0.85} 0 ${-w * 0.6} ${h * 0.5}`} stroke="#fff" strokeWidth="0.8" opacity="0.35" fill="none" strokeLinecap="round" />
    </g>
  );
  return (
    <>
      <defs>
        <Rad id={id("p")} c={["#ffc46b", "#f5862e", "#c9521a"]} />
        <Rad id={id("face")} c={["#fffbd1", "#ffd84a", "#ff9a1f"]} cx={0.5} cy={0.5} />
        <Lin id={id("bat")} c={["#5a4a78", "#2a2140"]} />
      </defs>
      <g transform="translate(28 92) scale(1.22) translate(-28 -92)">
      <path d="M10 93 C14 99 24 98 30 95 C36 92 44 96 50 99" stroke="#4f7a1e" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      <path d="M44 96 q2 -4 5 -2.4 q-1 3 -5 2.4 Z" fill="#6b9a2b" />
      {pumpkin(21, 83, 12, 9.4, 0)}
      {pumpkin(40, 92.5, 8.2, 6.4, 0.7)}
      <path d="M12 74 q-4 -2 -3 -6 q2 3 5 3" stroke="#4f7a1e" strokeWidth="0.9" fill="none" strokeLinecap="round" />
      </g>
      {/* a bat at the top right */}
      <g transform="translate(83 10)">
        <g className="pk pk-bob" style={anim(0, 2.4)}>
          {["", "scale(-1 1)"].map(t => (
            <path key={t} transform={t} d="M0 0 C-3 -4 -8 -5 -12 -2.2 C-10.6 -1 -10 0.8 -10 2 C-8.2 0.6 -6.2 1 -5 2.6 C-3.8 1.2 -2 1.2 0 2.2 Z" fill={url("bat")} stroke="#1a1428" strokeWidth="0.5" strokeLinejoin="round" />
          ))}
          <ellipse cx="0" cy="0.6" rx="2.6" ry="3.2" fill={url("bat")} />
          <path d="M-2 -1.8 L-1.6 -4.2 L-0.6 -2.4 M2 -1.8 L1.6 -4.2 L0.6 -2.4" fill="#2a2140" stroke="#2a2140" strokeWidth="0.5" strokeLinejoin="round" />
          <circle cx="-0.9" cy="0" r="0.5" fill="#ffd84a" />
          <circle cx="0.9" cy="0" r="0.5" fill="#ffd84a" />
        </g>
      </g>
    </>
  );
};

const HOLLY =
  "M0 0 Q1.5 -2.6 3.2 -2.4 L3.6 -4.6 L5.6 -3 Q7.2 -4.9 8.8 -3.4 L10.6 -4.8 L11.2 -2.6 Q13.4 -2.4 15 0 Q13.4 2.4 11.2 2.6 L10.6 4.8 L8.8 3.4 Q7.2 4.9 5.6 3 L3.6 4.6 L3.2 2.4 Q1.5 2.6 0 0 Z";

const holly: Art = u => {
  const [id, url] = ids(u);
  const sprig = (x: number, y: number, angles: number[], s: number, berries: [number, number][]) => (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      {angles.map(a => (
        <g key={a} transform={`rotate(${a})`}>
          <path d={HOLLY} fill={url("l")} stroke="#123f1d" strokeWidth="0.7" strokeLinejoin="round" />
          <path d="M0.6 0 L14 0" stroke="#8fd18a" strokeWidth="0.5" opacity="0.8" />
        </g>
      ))}
      {berries.map(([bx, by]) => (
        <g key={`${bx}${by}`}>
          <circle cx={bx} cy={by} r="2.5" fill={url("b")} stroke="#6e0a14" strokeWidth="0.5" />
          <circle cx={bx - 0.8} cy={by - 0.8} r="0.7" fill="#fff" opacity="0.85" />
        </g>
      ))}
    </g>
  );
  return (
    <>
      <defs>
        <Lin id={id("l")} c={["#4fb35a", "#23753a", "#155a2a"]} />
        <Rad id={id("b")} c={["#ff8a8a", "#e01e2e", "#99101c"]} />
      </defs>
      {sprig(19, 82, [190, 235, 280], 1.4, [
        [0.5, -1.5],
        [3, 1.2],
        [-2, 1.6],
      ])}
      {sprig(81, 17, [-20, 30], 1, [
        [0, 0],
        [-2.8, -1.4],
      ])}
      <Sparkle x={8} y={60} r={2.4} fill="#e6f6ff" d={0} />
      <Sparkle x={92} y={34} r={2} fill="#e6f6ff" d={1.2} />
      <Sparkle x={34} y={95} r={1.8} fill="#e6f6ff" d={0.6} />
    </>
  );
};

const winterBeanie: Art = u => {
  const [id, url] = ids(u);
  const ribs = Array.from({ length: 15 }, (_, i) => {
    const t = (i + 0.5) / 15;
    const x = 19 + 62 * t;
    const dip = 20 * t * (1 - t);
    return `M${x.toFixed(1)} ${(23.4 - dip).toFixed(1)} L${x.toFixed(1)} ${(28.6 - dip).toFixed(1)}`;
  }).join(" ");
  return (
    <>
      <defs>
        <Lin id={id("d")} c={["#ff8a7a", "#e8483f", "#b52a2a"]} />
        <Lin id={id("c")} c={["#fffaf0", "#eadcc6"]} />
        <Rad id={id("pom")} c={["#ffffff", "#f6efe4", "#dccfbd"]} />
      </defs>
      <path d="M22 24 C22 6 36 -2 50 -2 C64 -2 78 6 78 24 Z" fill={url("d")} stroke="#8e1f1f" strokeWidth="1.1" strokeLinejoin="round" />
      {[34, 42, 50, 58, 66].map(x => (
        <path key={x} d={`M${x - 2} 4 L${x} 6.4 L${x + 2} 4 M${x - 2} 9 L${x} 11.4 L${x + 2} 9 M${x - 2} 14 L${x} 16.4 L${x + 2} 14`} stroke="#ff9e94" strokeWidth="0.7" fill="none" opacity="0.7" strokeLinejoin="round" />
      ))}
      <path d="M27 18 C27 8 34 2 42 0" stroke="#fff" strokeWidth="1.2" opacity="0.35" fill="none" strokeLinecap="round" />
      <path d="M19 22 Q50 12 81 22 L82 30 Q50 20 18 30 Z" fill={url("c")} stroke="#ad9a80" strokeWidth="1" strokeLinejoin="round" />
      <path d={ribs} stroke="#d4c1a6" strokeWidth="0.9" strokeLinecap="round" />
      <g className="pk pk-bob" style={anim(0, 2.6)}>
        {Array.from({ length: 8 }, (_, i) => {
          const a = (i * Math.PI) / 4;
          return <circle key={i} cx={50 + Math.cos(a) * 4.6} cy={-4 + Math.sin(a) * 4.6} r="3.2" fill={url("pom")} stroke="#c9b9a2" strokeWidth="0.6" />;
        })}
        <circle cx="50" cy="-4" r="5.4" fill={url("pom")} />
        <circle cx="48" cy="-6" r="1.6" fill="#fff" />
      </g>
    </>
  );
};

const headphones: Art = u => {
  const [id, url] = ids(u);
  const cup = (
    <>
      <rect x="2.5" y="36" width="13" height="27" rx="6.2" fill={url("cup")} stroke="#3b2d73" strokeWidth="1.1" />
      <rect x="11" y="39" width="6.4" height="21" rx="3.2" fill="#2f2650" />
      <path d="M5.4 41 Q4.6 49 5.4 57" stroke="#fff" strokeWidth="1.1" opacity="0.5" fill="none" strokeLinecap="round" />
      <circle cx="8" cy="58.6" r="0.9" fill="#7ff7ff" />
    </>
  );
  const note = (x: number, y: number, d: number, s: number) => (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <g className="pk pk-rise" style={anim(d, 3.2)}>
        <ellipse cx="0" cy="0" rx="2.2" ry="1.6" transform="rotate(-20)" fill="#fff" />
        <path d="M1.9 -0.4 L1.9 -8 Q5 -7 5 -4" stroke="#fff" strokeWidth="1" fill="none" strokeLinecap="round" />
      </g>
    </g>
  );
  return (
    <>
      <defs>
        <Lin id={id("cup")} c={["#d4c4ff", "#9c80f0", "#6e52d0"]} />
        <Lin id={id("band")} c={["#5a4a9a", "#2f2650"]} />
      </defs>
      <path d="M10 44 C8 16 28 2 50 2 C72 2 92 16 90 44" stroke="#2a2148" strokeWidth="5.6" fill="none" strokeLinecap="round" />
      <path d="M10 44 C8 16 28 2 50 2 C72 2 92 16 90 44" stroke={url("band")} strokeWidth="3.6" fill="none" strokeLinecap="round" />
      <path d="M38 4.2 Q50 0.6 62 4.2" stroke={url("cup")} strokeWidth="6" fill="none" strokeLinecap="round" />
      <path d="M41 2.4 Q50 0 59 2.4" stroke="#fff" strokeWidth="1" opacity="0.5" fill="none" strokeLinecap="round" />
      {cup}
      <g transform={MIRROR}>{cup}</g>
      {note(93, 32, 0, 0.9)}
      {note(88, 26, 1.6, 0.7)}
    </>
  );
};

export const DECORATION_ART: Record<string, Art> = {
  "cat-ears": catEars,
  "bunny-ears": bunnyEars,
  "frog-friend": frogFriend,
  "autumn-leaves": autumnLeaves,
  "flower-crown": flowerCrown,
  "sakura-branch": sakuraBranch,
  mushrooms,
  sprout,
  "royal-crown": royalCrown,
  "devil-horns": devilHorns,
  "angel-wings": angelWings,
  "star-halo": starHalo,
  "witch-hat": witchHat,
  pumpkins,
  holly,
  "winter-beanie": winterBeanie,
  headphones,
};
