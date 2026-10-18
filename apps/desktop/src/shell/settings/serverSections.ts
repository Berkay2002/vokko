// Server Settings sections and who may see them. Kept out of ServerSettings.tsx so the rail context menu can list them without
// pulling the whole settings chunk into the startup bundle.

import { Perm } from "../../api/permissions";

export interface SectionDef {
  id: string;
  label: string;
  /** Sidebar block; headings come from GROUP_TITLES, "" renders without one. */
  group: "top" | "expression" | "people" | "apps" | "moderation" | "bottom";
  /** Category headings shown on pages that are not implemented. */
  outline?: string[];
  /** Any of these permission bits makes the section visible (Q4.6). Empty: MANAGE_GUILD. */
  needs?: bigint[];
}

export const MANAGE = [Perm.MANAGE_GUILD];
const EXPRESSIONS = [Perm.MANAGE_GUILD, Perm.MANAGE_GUILD_EXPRESSIONS];

export const SECTIONS: SectionDef[] = [
  { id: "profile", label: "Server Profile", group: "top" },
  { id: "tag", label: "Server Tag", group: "top" },
  { id: "theme", label: "Server Theme", group: "top" },
  { id: "engagement", label: "Engagement", group: "top" },
  { id: "emoji", label: "Emoji", group: "expression", needs: EXPRESSIONS },
  { id: "stickers", label: "Stickers", group: "expression", needs: EXPRESSIONS, outline: ["Upload Sticker", "Stickers"] },
  { id: "soundboard", label: "Soundboard", group: "expression", needs: [...EXPRESSIONS, Perm.CREATE_GUILD_EXPRESSIONS] },
  { id: "members", label: "Members", group: "people", needs: [Perm.MANAGE_GUILD, Perm.KICK_MEMBERS, Perm.BAN_MEMBERS, Perm.MODERATE_MEMBERS, Perm.MANAGE_NICKNAMES, Perm.MANAGE_ROLES] },
  { id: "requests", label: "Join Requests", group: "people", needs: [Perm.KICK_MEMBERS, Perm.MANAGE_GUILD] },
  { id: "roles", label: "Roles", group: "people", needs: [Perm.MANAGE_ROLES] },
  { id: "invites", label: "Invites", group: "people", needs: [Perm.CREATE_INSTANT_INVITE, Perm.MANAGE_GUILD] },
  { id: "onboarding", label: "Onboarding", group: "people" },
  { id: "access", label: "Access", group: "people", outline: ["Access Options", "Age-Restricted Server", "Server Rules"] },
  { id: "integrations", label: "Integrations", group: "apps", needs: [Perm.MANAGE_GUILD, Perm.MANAGE_WEBHOOKS] },
  { id: "activities", label: "Activities", group: "apps" },
  { id: "safety", label: "Safety Setup", group: "moderation" },
  { id: "audit", label: "Audit Log", group: "moderation", needs: [Perm.VIEW_AUDIT_LOG] },
  { id: "bans", label: "Bans", group: "moderation", needs: [Perm.BAN_MEMBERS] },
  { id: "reports", label: "Reports", group: "moderation", needs: [Perm.MANAGE_MESSAGES, Perm.MODERATE_MEMBERS] },
  { id: "automod", label: "AutoMod", group: "moderation" },
  { id: "community", label: "Enable Community", group: "bottom" },
  { id: "template", label: "Server Template", group: "bottom" },
];

/** Sections the viewer may open (rail context menu "Server Settings" submenu). */
export function serverSettingsSections(can: (bit: bigint) => boolean): { id: string; label: string }[] {
  return SECTIONS.filter(s => (s.needs ?? MANAGE).some(bit => can(bit))).map(s => ({ id: s.id, label: s.label }));
}
