import type { SVGProps } from "react";
import { siSpotify } from "simple-icons";

/** Spotify's own mark from simple-icons (CC0), unmodified, in its brand colour; the only place Spotify green appears. */
export function SpotifyIcon({ size = 18, ...rest }: { size?: number } & Omit<SVGProps<SVGSVGElement>, "width" | "height">) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...rest}>
      <path d={siSpotify.path} fill={`#${siSpotify.hex}`} />
    </svg>
  );
}
