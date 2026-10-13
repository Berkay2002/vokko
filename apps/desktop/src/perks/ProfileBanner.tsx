import type { ReactNode } from "react";
import { AnimatedImage } from "../ui/AnimatedMedia";
import { ProfileEffect } from "./ProfileEffect";
import { bannerStyle, type ProfileLook } from "./profile";

export const isGifUrl = (url: string): boolean => /\.gif(?:[?#]|$)/i.test(url);

/** An animated banner: it plays like an animated avatar (follows "Play GIFs", a still first frame under reduced motion, plays on hover or focus). */
export function BannerGif({ src }: { src: string }) {
  return <AnimatedImage kind="gif" stillWhenReduced className="pv-banner-img" src={src} alt="" draggable={false} />;
}

/**
 * The banner strip of a profile surface: banner image, else banner colour, else the theme's primary colour, with the profile effect
 * playing over it. `className` carries the surface's own size and radius (`profile-banner`, `dm-profile-banner`, ...).
 */
export function ProfileBanner({ look, className, children }: { look: Pick<ProfileLook, "banner" | "bannerColor" | "themeColors" | "effect">; className: string; children?: ReactNode }) {
  const gif = look.banner && isGifUrl(look.banner) ? look.banner : null;
  return (
    <div className={`${className} pv-banner`} style={bannerStyle(gif ? { ...look, banner: null } : look)}>
      {gif && <BannerGif src={gif} />}
      <ProfileEffect id={look.effect} />
      {children}
    </div>
  );
}
