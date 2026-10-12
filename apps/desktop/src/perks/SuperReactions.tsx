import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import type { Reaction } from "../api/types";
import { reducedMotionActive, usePrefs } from "../ui/prefs";
import { burstColors } from "./emojiColors";
import "./super-reactions.css";

/** Particles only play with motion allowed and animated emoji on (Accessibility settings). */
export function useBurstMotion(): boolean {
  const reduced = usePrefs(reducedMotionActive);
  const animated = usePrefs(s => s.playAnimatedEmoji);
  return !reduced && animated;
}

/** CSS variables of a burst pill's glow: the emoji's two dominant colours (`--burst-a`, `--burst-b`). */
export function burstStyle(reaction: Pick<Reaction, "emoji" | "burst_colors">): CSSProperties {
  const [a, b] = burstColors(reaction.emoji, reaction.burst_colors);
  return { ["--burst-a" as string]: a, ["--burst-b" as string]: b ?? a } as CSSProperties;
}

/** Super reactions added in the last moment (message id + emoji key → time), so a pill that mounts or grows because of one plays its burst. */
const recentBursts = new Map<string, number>();
const RECENT_MS = 1500;

/** Called by the message store when a super reaction is added (the viewer's own or from the gateway). */
export function announceBurst(messageId: string, emojiKey: string): void {
  const now = Date.now();
  for (const [key, at] of recentBursts) if (now - at > RECENT_MS) recentBursts.delete(key);
  recentBursts.set(`${messageId}:${emojiKey}`, now);
}

function takeBurst(key: string): boolean {
  const at = recentBursts.get(key);
  recentBursts.delete(key);
  return at !== undefined && Date.now() - at <= RECENT_MS;
}

const PARTICLES = 10;
const PARTICLE_MS = 750;

/** A short ring of particles flying out of the pill; unmounts itself when done. Rendered only when motion is allowed. */
export function BurstParticles({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, PARTICLE_MS);
    return () => clearTimeout(timer);
  }, [onDone]);
  return (
    <span className="burst-particles" aria-hidden="true" data-testid="burst-particles">
      {Array.from({ length: PARTICLES }, (_, i) => {
        const angle = (i / PARTICLES) * Math.PI * 2;
        const distance = 18 + (i % 3) * 6;
        const style = {
          ["--bp-x" as string]: `${(Math.cos(angle) * distance).toFixed(1)}px`,
          ["--bp-y" as string]: `${(Math.sin(angle) * distance).toFixed(1)}px`,
          ["--bp-color" as string]: i % 2 ? "var(--burst-b)" : "var(--burst-a)",
          animationDelay: `${(i % 4) * 25}ms`,
        } as CSSProperties;
        return <span key={i} className="burst-particle" style={style} />;
      })}
    </span>
  );
}

/**
 * A super reaction pill: the emoji with a glow in its own colours and the burst count. Plays the particle burst when a super reaction was
 * just added (the viewer's own or someone else's, see `announceBurst`), not when a message with super reactions is merely loaded.
 */
export function BurstPill({ messageId, emojiKey, reaction, label, onClick, emoji, onHover }: {
  messageId: string;
  emojiKey: string;
  reaction: Reaction;
  label: string;
  onClick: () => void;
  emoji: ReactNode;
  onHover?: () => void;
}) {
  const motion = useBurstMotion();
  const count = reaction.count_details.burst;
  const [playing, setPlaying] = useState(0);
  useEffect(() => {
    if (takeBurst(`${messageId}:${emojiKey}`) && motion) setPlaying(n => n + 1);
  }, [count, motion, messageId, emojiKey]);
  const style = useMemo(() => burstStyle(reaction), [reaction]);
  return (
    <button type="button" className={`chat-reaction burst${reaction.me_burst ? " me" : ""}`} style={style} aria-pressed={reaction.me_burst} aria-label={label}
      data-burst="true" onMouseEnter={onHover} onFocus={onHover} onClick={onClick}>
      <span className="burst-emoji">{emoji}</span>
      <span className="chat-reaction-count">{count}</span>
      {playing > 0 && <BurstParticles key={playing} onDone={() => setPlaying(0)} />}
    </button>
  );
}

/** The "Super Reaction" switch in the reaction picker. */
export function SuperReactToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" className={`super-react-toggle${on ? " on" : ""}`} aria-pressed={on} aria-label="Super Reaction" title="Super Reaction" onClick={() => onChange(!on)}>
      <Sparkles size={18} aria-hidden="true" />
    </button>
  );
}

/** One line of a reactors tooltip: "A, B and 2 others reacted with 🔥" / "... super reacted with 🔥". */
export function whoLine(names: string[], total: number, emojiLabel: string, burst: boolean): string {
  const verb = burst ? "super reacted" : "reacted";
  const shown = names.slice(0, 3);
  const rest = total - shown.length;
  if (shown.length === 0) return `${total} ${verb} with ${emojiLabel}`;
  if (rest > 0) return `${shown.join(", ")} and ${rest} ${rest === 1 ? "other" : "others"} ${verb} with ${emojiLabel}`;
  if (shown.length === 1) return `${shown[0]} ${verb} with ${emojiLabel}`;
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]} ${verb} with ${emojiLabel}`;
}

/** Tooltip body with super reactions and normal reactions as separate sections (a section only when that type has reactions). */
export function SplitReactors({ burst, normal }: { burst: string | null; normal: string | null }) {
  if (burst && normal) {
    return (
      <span className="reactors-split">
        <span className="reactors-head"><Sparkles size={12} aria-hidden="true" /> Super Reactions</span>
        <span>{burst}</span>
        <span className="reactors-head">Reactions</span>
        <span>{normal}</span>
      </span>
    );
  }
  return <>{burst ?? normal}</>;
}
