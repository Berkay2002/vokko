import type { SVGProps } from "react";
import { siStremio } from "simple-icons";

/** Stremio's own mark from simple-icons (CC0), unmodified, in its brand colour. */
export function StremioIcon({ size = 18, ...rest }: { size?: number } & Omit<SVGProps<SVGSVGElement>, "width" | "height">) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...rest}>
      <path d={siStremio.path} fill={`#${siStremio.hex}`} />
    </svg>
  );
}
