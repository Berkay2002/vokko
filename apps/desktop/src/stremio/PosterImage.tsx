import { useState, type ReactNode } from "react";

/** A poster or thumbnail that shows `fallback` instead of a broken image when there is no URL or it fails to load. */
export function PosterImage({ src, className, lazy, fallback = null }: { src?: string; className?: string; lazy?: boolean; fallback?: ReactNode }) {
  const [failed, setFailed] = useState<string>();
  if (!src || failed === src) return <>{fallback}</>;
  return <img className={className} src={src} alt="" loading={lazy ? "lazy" : undefined} onError={() => setFailed(src)} />;
}
