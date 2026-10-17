import type { SVGProps } from "react";

/** Stremio's mark (a violet tile with a white play triangle), drawn as a plain SVG so it needs no asset file and scales with `size`. */
export function StremioIcon({ size = 18, ...rest }: { size?: number } & Omit<SVGProps<SVGSVGElement>, "width" | "height">) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...rest}>
      <rect width="24" height="24" rx="6" fill="#7b5bf5" />
      <path d="M9.2 6.9a.9.9 0 0 1 1.35-.78l7.1 4.1a.9.9 0 0 1 0 1.56l-7.1 4.1a.9.9 0 0 1-1.35-.78z" fill="#fff" />
    </svg>
  );
}
