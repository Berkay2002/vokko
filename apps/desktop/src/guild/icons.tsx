/** Hand-made channel icons that lucide has no equivalent for. Same stroke style as lucide (24 grid, round caps, currentColor). */

interface IconProps {
  size?: number;
  className?: string;
}

/** Age-restricted (NSFW) text channel: a hash with an exclamation mark in place of its right half. */
export function NsfwHash({ size = 20, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-label="Age-restricted" role="img">
      <line x1="4" x2="15" y1="9" y2="9" />
      <line x1="3" x2="14" y1="15" y2="15" />
      <line x1="10" x2="7" y1="3" y2="21" />
      <line x1="20" x2="20" y1="4" y2="14" />
      <line x1="20" x2="20.01" y1="20" y2="20" />
    </svg>
  );
}
