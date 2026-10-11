// The soundboard flash on a speaking ring: the sound's emoji pops over the sender's avatar for a moment.

import type { Snowflake } from "../api/types";
import { useSoundEffect } from "./store";

/** Class to add to a tile / occupant while its user's sound effect is showing. */
export function useSoundFlashClass(userId: Snowflake): string {
  return useSoundEffect(userId) ? " sound-flash" : "";
}

export function SoundEffectBadge({ userId }: { userId: Snowflake }) {
  const effect = useSoundEffect(userId);
  if (!effect) return null;
  return (
    <span key={effect.serial} className={`sb-effect${effect.entrance ? " entrance" : ""}`} data-sound-effect={effect.emoji ?? "sound"} aria-hidden="true">
      {effect.emoji ?? "🔊"}
    </span>
  );
}
