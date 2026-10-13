import type { CSSProperties } from "react";
import type { GuildMember, User } from "../api/types";
import { intToHex } from "./catalog";

/** The profile fields as shown to a viewer: the member's per-server values win over the user's own inside a guild. */
export interface ProfileLook {
  avatar: string | null;
  banner: string | null;
  bannerColor: string | null;
  bio: string | null;
  pronouns: string | null;
  themeColors: [number, number] | null;
  decoration: string | null;
  effect: string | null;
  /** Profile frame id (main profile only). */
  frame: string | null;
}

type MemberProfile = Pick<GuildMember, "avatar" | "banner" | "bio" | "pronouns" | "theme_colors">;

export function resolveProfile(user: User, member?: Partial<MemberProfile> | null): ProfileLook {
  return {
    avatar: member?.avatar || user.avatar,
    banner: member?.banner || user.banner || null,
    bannerColor: user.banner_color,
    bio: member?.bio || user.bio,
    pronouns: member?.pronouns || user.pronouns || null,
    themeColors: member?.theme_colors || user.theme_colors || null,
    decoration: user.avatar_decoration ?? null,
    effect: user.profile_effect ?? null,
    frame: user.profile_frame ?? null,
  };
}

/** Inline CSS variables of a themed card (`--pv-primary`, `--pv-accent`); undefined when the profile has no theme colours. */
export function themeVars(colors: [number, number] | null | undefined): CSSProperties | undefined {
  if (!colors) return undefined;
  return { ["--pv-primary" as string]: intToHex(colors[0]), ["--pv-accent" as string]: intToHex(colors[1]) } as CSSProperties;
}

/** Banner background: image first, then the banner colour, then the theme's primary colour, then the brand colour. */
export function bannerStyle(look: Pick<ProfileLook, "banner" | "bannerColor" | "themeColors">): CSSProperties {
  if (look.banner) return { backgroundImage: `url("${look.banner}")`, backgroundSize: "cover", backgroundPosition: "center" };
  if (look.bannerColor) return { background: look.bannerColor };
  if (look.themeColors) return { background: intToHex(look.themeColors[0]) };
  return { background: "var(--brand-500)" };
}
