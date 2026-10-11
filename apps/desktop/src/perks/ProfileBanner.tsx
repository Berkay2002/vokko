import type { ReactNode } from "react";
import { ProfileEffect } from "./ProfileEffect";
import { bannerStyle, type ProfileLook } from "./profile";

/**
 * The banner strip of a profile surface: banner image, else banner colour, else the theme's primary colour, with the profile effect
 * playing over it. `className` carries the surface's own size and radius (`profile-banner`, `dm-profile-banner`, ...).
 */
export function ProfileBanner({ look, className, children }: { look: Pick<ProfileLook, "banner" | "bannerColor" | "themeColors" | "effect">; className: string; children?: ReactNode }) {
  return (
    <div className={`${className} pv-banner`} style={bannerStyle(look)}>
      <ProfileEffect id={look.effect} />
      {children}
    </div>
  );
}
