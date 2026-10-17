import type { SimpleIcon } from "simple-icons";

/** A simple-icons (CC0) mark, unmodified; currentColor unless `color` is given. */
export function BrandIcon({ icon, size = 20, color, className }: { icon: Pick<SimpleIcon, "path">; size?: number; color?: string; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill={color ?? "currentColor"} aria-hidden="true">
      <path d={icon.path} />
    </svg>
  );
}
