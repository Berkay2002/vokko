import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ImgHTMLAttributes, VideoHTMLAttributes } from "react";
import { reducedMotionActive, usePrefs } from "./prefs";

/**
 * Animated media that obeys the Accessibility settings: "Play GIFs when Vokko is focused", "Play animated emoji" and
 * "Sticker animations". An image that may not play right now shows its first frame (drawn on a canvas, which works for
 * cross-origin images too) and animates while the pointer or keyboard focus is on it. A video GIF is paused the same way.
 */

export type AnimationKind = "gif" | "emoji" | "sticker";
export type AnimationPolicy = "always" | "interaction" | "never";

/** Whether media of this kind plays by itself, only on hover/focus, or never. */
export function useAnimationPolicy(kind: AnimationKind): AnimationPolicy {
  const gifs = usePrefs(s => s.playGifs);
  const emoji = usePrefs(s => s.playAnimatedEmoji);
  const stickers = usePrefs(s => s.stickerAnimation);
  if (kind === "gif") return gifs ? "always" : "interaction";
  if (kind === "emoji") return emoji ? "always" : "interaction";
  return stickers;
}

function subscribeFocus(callback: () => void): () => void {
  window.addEventListener("focus", callback);
  window.addEventListener("blur", callback);
  return () => {
    window.removeEventListener("focus", callback);
    window.removeEventListener("blur", callback);
  };
}

/** True while the app window has focus. GIFs only play on their own while it does. */
function useWindowFocused(): boolean {
  return useSyncExternalStore(subscribeFocus, () => document.hasFocus(), () => true);
}

/** Pure rule behind the components: does the media animate right now? */
export function isPlaying(policy: AnimationPolicy, kind: AnimationKind, interacting: boolean, windowFocused: boolean): boolean {
  if (policy === "never") return false;
  if (policy === "interaction") return interacting;
  return kind === "gif" ? windowFocused || interacting : true;
}

function usePlaying(kind: AnimationKind, stillWhenReduced = false) {
  const reduced = usePrefs(reducedMotionActive);
  const base = useAnimationPolicy(kind);
  const policy = stillWhenReduced && reduced && kind === "gif" ? "interaction" : base;
  const focused = useWindowFocused();
  const [interacting, setInteracting] = useState(false);
  const playing = isPlaying(policy, kind, interacting, focused);
  const handlers = {
    onMouseEnter: () => setInteracting(true),
    onMouseLeave: () => setInteracting(false),
    onFocus: () => setInteracting(true),
    onBlur: () => setInteracting(false),
  };
  return { policy, playing, interacting, setInteracting, handlers };
}

/**
 * The still frame (a canvas) and the playing image are different elements, so React swaps one for the other under a
 * stationary pointer and the browser may never send mouseleave to the new one. While the pointer counts as "on" the media,
 * stop that as soon as the pointer is seen anywhere else (unless the media still has keyboard focus).
 */
function useReleaseWhenPointerLeaves(active: boolean, element: () => Element | null, release: () => void) {
  const elementRef = useRef(element);
  elementRef.current = element;
  const releaseRef = useRef(release);
  releaseRef.current = release;
  useEffect(() => {
    if (!active) return;
    const onMove = (e: PointerEvent) => {
      const el = elementRef.current();
      if (!el || (e.target instanceof Node && el.contains(e.target)) || document.activeElement === el) return;
      releaseRef.current();
    };
    document.addEventListener("pointermove", onMove, true);
    return () => document.removeEventListener("pointermove", onMove, true);
  }, [active]);
}

type ImgProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & {
  src: string;
  alt: string;
  kind: AnimationKind;
  /** A GIF also stays on its first frame under reduced motion (avatars do; chat GIFs only follow "Play GIFs"). */
  stillWhenReduced?: boolean;
};

export function AnimatedImage({ kind, stillWhenReduced, src, alt, className, style, width, height, tabIndex, ...rest }: ImgProps) {
  const { policy, playing, interacting, setInteracting, handlers } = usePlaying(kind, stillWhenReduced);
  const [drawn, setDrawn] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const needsStill = !playing;
  useReleaseWhenPointerLeaves(interacting && policy !== "always", () => canvas.current ?? image.current, () => setInteracting(false));

  useEffect(() => {
    if (!needsStill) return;
    let cancelled = false;
    const probe = new Image();
    probe.onload = () => {
      const el = canvas.current;
      if (cancelled || !el) return;
      el.width = probe.naturalWidth || 1;
      el.height = probe.naturalHeight || 1;
      el.getContext("2d")?.drawImage(probe, 0, 0);
      setDrawn(src);
    };
    probe.src = src;
    return () => {
      cancelled = true;
    };
  }, [needsStill, src]);

  const size: CSSProperties = { ...(width !== undefined ? { width } : null), ...(height !== undefined ? { height } : null), ...style };
  const focusable = policy === "interaction" && kind === "sticker" ? (tabIndex ?? 0) : tabIndex;
  const still = needsStill && drawn === src;
  return (
    <>
      {needsStill && <canvas ref={canvas} className={className} style={still ? size : { display: "none" }} role="img" aria-label={alt} title={rest.title} tabIndex={focusable} {...handlers} />}
      {!still && <img {...rest} {...handlers} ref={image} className={className} style={size} src={src} alt={alt} width={width} height={height} tabIndex={tabIndex} />}
    </>
  );
}

type VideoProps = Omit<VideoHTMLAttributes<HTMLVideoElement>, "autoPlay"> & { kind?: AnimationKind };

/** A video that stands in for a GIF (muted, looping). */
export function AnimatedVideo({ kind = "gif", ...props }: VideoProps) {
  const { playing, handlers } = usePlaying(kind);
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (playing) void el.play().catch(() => undefined);
    else el.pause();
  }, [playing]);
  return <video ref={ref} preload="metadata" {...props} autoPlay={playing} {...handlers} />;
}
