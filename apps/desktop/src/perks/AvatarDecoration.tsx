import { useId } from "react";
import { decorationById } from "./catalog";

const STAR = "0,-1 0.29,-0.4 0.95,-0.31 0.47,0.15 0.59,0.81 0,0.5 -0.59,0.81 -0.47,0.15 -0.95,-0.31 -0.29,-0.4";

/**
 * An avatar decoration drawn as a ring (and optional ornaments) around the avatar. Mount it inside a `position: relative` box that is
 * exactly the avatar's size; it overflows by 12.5% on every side and ignores the pointer. Decorations are Vokko's own set (src/perks/catalog.ts).
 */
export function AvatarDecoration({ id }: { id: string | null | undefined }) {
  const def = decorationById(id);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  if (!def) return null;
  const gradient = `deco-g-${uid}`;
  const glow = `deco-f-${uid}`;
  const radius = 40 + def.width / 2 + 1.5;
  const ornaments = def.ornaments;
  return (
    <svg className={`avatar-deco${def.pulse ? " pulse" : ""}`} viewBox="0 0 100 100" aria-hidden="true" focusable="false" data-decoration={def.id}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          {def.colors.map((color, i) => (
            <stop key={i} offset={def.colors.length === 1 ? 0 : i / (def.colors.length - 1)} stopColor={color} />
          ))}
        </linearGradient>
        {def.glow && (
          <filter id={glow} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="1.6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        )}
      </defs>
      <g className={def.spin ? "avatar-deco-spin" : undefined} style={def.spin ? { animationDuration: `${def.spin}s` } : undefined} filter={def.glow ? `url(#${glow})` : undefined}>
        <circle cx="50" cy="50" r={radius} fill="none" stroke={`url(#${gradient})`} strokeWidth={def.width} strokeDasharray={def.dash} strokeLinecap={def.dash ? "butt" : "round"} />
        {ornaments &&
          Array.from({ length: ornaments.count }, (_, i) => {
            const angle = (i / ornaments.count) * Math.PI * 2 - Math.PI / 2;
            const x = 50 + Math.cos(angle) * radius;
            const y = 50 + Math.sin(angle) * radius;
            if (ornaments.shape === "dot") return <circle key={i} cx={x} cy={y} r={2.4} fill={ornaments.color} />;
            if (ornaments.shape === "diamond") return <rect key={i} x={-2.6} y={-2.6} width={5.2} height={5.2} fill={ornaments.color} transform={`translate(${x} ${y}) rotate(45)`} />;
            return <polygon key={i} points={STAR} fill={ornaments.color} transform={`translate(${x} ${y}) scale(4.4) rotate(${(angle * 180) / Math.PI + 90})`} />;
          })}
      </g>
    </svg>
  );
}
