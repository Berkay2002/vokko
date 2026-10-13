import { useId, useMemo } from "react";
import type { CSSProperties } from "react";
import { effectById } from "./catalog";
import type { ProfileLook } from "./profile";
import { EFFECT_SHAPES } from "./art/effects";
import { FRAME_ART, FrameSvg } from "./art/frames";
import { SCENES } from "./art/scenes";

/** Deterministic pseudo-random in [0, 1): the same effect always lays its particles out the same way. */
const rand = (i: number, salt: number): number => {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/** The effect is a full-card scene (perks/art/scenes.tsx), which plays over the whole card rather than the banner. */
export const isSceneEffect = (id: string | null | undefined): boolean => !!effectById(id)?.scene;

/** A full-card scene: its intro plays on mount (keyed by id, so switching scenes replays it), then it idles. */
function ProfileScene({ id }: { id: string }) {
  const u = `fx${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  // Own keys only: ids come from other users' profiles, and "constructor" or "__proto__" would reach Object.prototype.
  const art = Object.hasOwn(SCENES, id) ? SCENES[id] : undefined;
  if (!art) return null;
  return (
    <div className="profile-effect pfx" aria-hidden="true" data-effect={id}>
      {art(u)}
    </div>
  );
}

/** A profile frame: a drawn border over the edges and corners of the whole card (perks/art/frames.tsx). */
export function ProfileFrame({ id }: { id: string | null | undefined }) {
  const u = `fr${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const art = id && Object.hasOwn(FRAME_ART, id) ? FRAME_ART[id] : undefined;
  if (!art || !id) return null;
  return (
    <div className="profile-frame" aria-hidden="true" data-frame={id}>
      <FrameSvg parts={art(u)} u={u} />
    </div>
  );
}

/**
 * What plays over a whole profile card: a scene effect and the frame. The card must be positioned; particle effects stay in the
 * banner (ProfileBanner draws them).
 */
export function ProfileCardLayers({ look }: { look: Pick<ProfileLook, "effect" | "frame"> }) {
  return (
    <>
      {look.effect && isSceneEffect(look.effect) && <ProfileScene key={look.effect} id={look.effect} />}
      <ProfileFrame id={look.frame} />
    </>
  );
}

/**
 * A profile effect: a layer of small animated particles over the banner and header of a profile, or a full-card scene. Absolutely
 * positioned and clipped by its parent; honours reduced motion (particles sit still, scenes show a still frame).
 */
export function ProfileEffect({ id }: { id: string | null | undefined }) {
  const def = effectById(id);
  const particles = useMemo(() => {
    if (!def || def.scene) return [];
    return Array.from({ length: def.count }, (_, i) => {
      const size = def.size[0] + rand(i, 1) * (def.size[1] - def.size[0]);
      const duration = def.duration[0] + rand(i, 2) * (def.duration[1] - def.duration[0]);
      return {
        key: i,
        style: {
          left: `${(rand(i, 3) * 100).toFixed(1)}%`,
          top: `${(rand(i, 4) * 100).toFixed(1)}%`,
          width: `${(def.shape === "shooting-star" ? size * 3 : size).toFixed(1)}px`,
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
  if (def.scene) return <ProfileScene key={def.id} id={def.id} />;
  const drawing = EFFECT_SHAPES[def.shape];
  return (
    <div className={`profile-effect pe-${def.motion}`} aria-hidden="true" data-effect={def.id}>
      {particles.map(p => (
        <span key={p.key} className={`pe-particle pe-${def.shape}${drawing ? " pe-art" : ""}`} style={p.style}>
          {drawing}
        </span>
      ))}
    </div>
  );
}
