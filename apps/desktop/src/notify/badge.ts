// Unread state outside the UI: the document title, the favicon dot (browser) and the window badge (Tauri).

import { isTauri } from "@tauri-apps/api/core";
import iconSvg from "../../../../assets/brand/vokko-icon.svg?raw";
import { IS_MAC } from "../desktop/tauri";
import { setTrayUnread } from "../desktop/tray";
import { dmName, joinedThreads, type AppState } from "../api/store";
import { ChannelType } from "../api/types";
import { compareIds } from "../api/snowflake";
import { isThreadUnread } from "../threads/util";
import { effectiveLevel, guildDefaultLevel, isMutedAt, withThreadMember, type NotifyLocalState } from "./decide";

export interface UnreadSummary {
  /** Total unread @mentions in channels that are not muted. */
  mentions: number;
  /** Something unread that is worth a dot (not muted, level not "only mentions" / "nothing"). */
  unread: boolean;
  /** Unread DM conversations that carry no mention count (the Dock badge counts them like mentions). */
  dms: number;
}

/** Counts what the user should be told about. Muted channels, categories and servers contribute nothing; joined threads count like their channel, plus their own mute and level. */
export function summarizeUnread(state: Pick<AppState, "channels" | "readStates"> & Partial<Pick<AppState, "guilds" | "threads">>, local: NotifyLocalState, now: number): UnreadSummary {
  let mentions = 0;
  let unread = false;
  let dms = 0;
  for (const thread of joinedThreads({ threads: state.threads ?? {} })) {
    const overlaid = withThreadMember(local, thread.id, thread.member);
    const parent = thread.parent_id ? state.channels[thread.parent_id] : undefined;
    const scopes = [thread.id, thread.parent_id, parent?.parent_id, thread.guild_id].filter((id): id is string => !!id);
    if (scopes.some(id => isMutedAt(overlaid, id, now))) continue;
    const level = effectiveLevel(overlaid, scopes, guildDefaultLevel(thread.guild_id ? state.guilds?.[thread.guild_id]?.default_message_notifications : undefined));
    if (level === "none") continue;
    mentions += state.readStates[thread.id]?.mention_count ?? 0;
    if (!unread && (level === "all" || level === "unreads-mentions") && isThreadUnread(thread, state.readStates[thread.id])) unread = true;
  }
  for (const channel of Object.values(state.channels)) {
    if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildCategory) continue;
    const scopes = [channel.id, channel.parent_id, channel.guild_id].filter((id): id is string => !!id);
    if (scopes.some(id => isMutedAt(local, id, now))) continue;
    const level = effectiveLevel(local, scopes, guildDefaultLevel(channel.guild_id ? state.guilds?.[channel.guild_id]?.default_message_notifications : undefined));
    if (level === "none") continue;
    const read = state.readStates[channel.id];
    mentions += read?.mention_count ?? 0;
    const unreadHere = !!channel.last_message_id && (!read?.last_message_id || compareIds(channel.last_message_id, read.last_message_id) > 0);
    const dotLevel = level === "all" || level === "unreads-mentions";
    if (!unread && dotLevel && unreadHere) unread = true;
    // A 1:1 DM is always addressed to me; a group DM only when its level would notify.
    const isDm = channel.type === ChannelType.DM || (channel.type === ChannelType.GroupDM && dotLevel);
    if (isDm && unreadHere && !read?.mention_count) dms += 1;
  }
  return { mentions, unread, dms };
}

const countText = (n: number): string => (n > 99 ? "99+" : String(n));

/** Dock tile label: the number of mentions plus unread DMs, "99+" past 99, undefined (no badge) at 0. */
export function dockBadgeLabel(summary: Pick<UnreadSummary, "mentions" | "dms">): string | undefined {
  const count = summary.mentions + summary.dms;
  return count > 0 ? countText(count) : undefined;
}

/** What the tab names: "#general | Vokko Lab", "@alice", "Friends"; null when signed out. */
export function pageLabel(state: Pick<AppState, "me" | "route" | "channels" | "guilds">): string | null {
  if (!state.me) return null;
  const channel = state.route.channelId ? state.channels[state.route.channelId] : undefined;
  if (channel?.guild_id) return `#${channel.name ?? "channel"} | ${state.guilds[channel.guild_id]?.name ?? "Vokko"}`;
  if (channel) return channel.type === ChannelType.DM ? `@${dmName(channel)}` : dmName(channel);
  if (state.route.guildId) return state.guilds[state.route.guildId]?.name ?? null;
  return "Friends";
}

/** "(3) Vokko | #general | Lab" with mentions, "• Vokko | …" with plain unread, "Vokko | …" otherwise (Discord's own format). */
export function formatTitle(base: string, summary: Pick<UnreadSummary, "mentions" | "unread">, label?: string | null): string {
  const name = label ? `${base} | ${label}` : base;
  if (summary.mentions > 0) return `(${countText(summary.mentions)}) ${name}`;
  if (summary.unread) return `• ${name}`;
  return name;
}

/** Our own icon with a badge: red with the count for mentions, a plain white dot for unread. */
export function faviconSvg(summary: Pick<UnreadSummary, "mentions" | "unread">): string {
  const base = iconSvg.trim().replace(/<\/svg>\s*$/, "");
  let badge = "";
  if (summary.mentions > 0) {
    const label = summary.mentions > 9 ? "9+" : String(summary.mentions);
    badge = `<circle cx="384" cy="128" r="128" fill="#f23f42"/><text x="384" y="${label.length > 1 ? 178 : 184}" font-family="sans-serif" font-weight="700" font-size="${label.length > 1 ? 130 : 170}" text-anchor="middle" fill="#fff">${label}</text>`;
  } else if (summary.unread) {
    badge = `<circle cx="392" cy="120" r="96" fill="#fff"/><circle cx="392" cy="120" r="64" fill="#f23f42"/>`;
  }
  // The badge coordinates are for a 512 box, the icon is drawn in 1024.
  return `${base}<g transform="scale(2)">${badge}</g></svg>`;
}

let faviconLink: HTMLLinkElement | null = null;
let lastFavicon = "";
let baseTitle = "";
let lastBadge: string | undefined | null = null;

function setFavicon(svg: string): void {
  if (svg === lastFavicon || typeof document === "undefined") return;
  lastFavicon = svg;
  if (!faviconLink) {
    faviconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement("link");
    faviconLink.rel = "icon";
    faviconLink.type = "image/svg+xml";
    if (!faviconLink.isConnected) document.head.appendChild(faviconLink);
  }
  faviconLink.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Tauri on macOS only. The Dock takes a text label ("99+"), granted to the window in `capabilities/macos.json`; other platforms
 * are not granted a badge permission, so the call is skipped there. `lastBadge` only moves after a success, so a
 * failed call is retried on the next refresh instead of leaving the badge stale.
 */
async function setWindowBadge(label: string | undefined): Promise<void> {
  if (!isTauri() || !IS_MAC || label === lastBadge) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setBadgeLabel(label);
    lastBadge = label;
  } catch {
    /* the call failed: retried on the next refresh */
  }
}

/** Applies the summary everywhere. `enabled` is the "unread badge" preference. */
export function applyUnread(summary: UnreadSummary, enabled: boolean, label: string | null = null): void {
  if (typeof document === "undefined") return;
  if (!baseTitle) baseTitle = document.title || "Vokko";
  const shown: UnreadSummary = enabled ? summary : { mentions: 0, unread: false, dms: 0 };
  const title = formatTitle(baseTitle, shown, label);
  if (document.title !== title) document.title = title;
  setFavicon(faviconSvg(shown));
  void setWindowBadge(dockBadgeLabel(shown));
  void setTrayUnread(shown.unread || shown.mentions > 0);
}
