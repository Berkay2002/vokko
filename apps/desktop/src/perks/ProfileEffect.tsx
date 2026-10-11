import { useMemo } from "react";
import type { CSSProperties } from "react";
import { effectById } from "./catalog";

/** Deterministic pseudo-random in [0, 1): the same effect always lays its particles out the same way. */
const rand = (i: number, salt: number): number => {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * A profile effect: a layer of small animated particles over the banner and header of a profile. Absolutely positioned and
 * clipped by its parent; honours reduced motion (the particles then sit still, see src/styles/perks.css).
 */
export function ProfileEffect({ id }: { id: string | null | undefined }) {
  const def = effectById(id);
  const particles = useMemo(() => {
    if (!def) return [];
    return Array.from({ length: def.count }, (_, i) => {
      const size = def.size[0] + rand(i, 1) * (def.size[1] - def.size[0]);
      const duration = def.duration[0] + rand(i, 2) * (def.duration[1] - def.duration[0]);
      return {
        key: i,
        style: {
          left: `${(rand(i, 3) * 100).toFixed(1)}%`,
          top: `${(rand(i, 4) * 100).toFixed(1)}%`,
          width: `${size.toFixed(1)}px`,
          height: `${(def.shape === "streak" ? size * 2.2 : size).toFixed(1)}px`,
          animationDuration: `${duration.toFixed(2)}s`,
          animationDelay: `${(-rand(i, 5) * duration).toFixed(2)}s`,
          ["--pe-color" as string]: def.colors[i % def.colors.length],
          ["--pe-sway" as string]: `${((rand(i, 6) - 0.5) * 36).toFixed(0)}px`,
          ["--pe-rot" as string]: `${(rand(i, 7) * 360).toFixed(0)}deg`,
        } as CSSProperties,
      };
    });
  }, [def]);
  if (!def) return null;
  return (
    <div className={`profile-effect pe-${def.motion}`} aria-hidden="true" data-effect={def.id}>
      {particles.map(p => (
        <span key={p.key} className={`pe-particle pe-${def.shape}`} style={p.style} />
      ))}
    </div>
  );
}
