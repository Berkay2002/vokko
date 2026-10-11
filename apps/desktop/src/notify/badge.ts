// Unread state outside the UI: the document title, the favicon dot (browser) and the window badge (Tauri).

import { isTauri } from "@tauri-apps/api/core";
import iconSvg from "../../assets/icon.svg?raw";
import { setTrayUnread } from "../desktop/tray";
import { dmName, type AppState } from "../api/store";
import { ChannelType } from "../api/types";
import { compareIds } from "../api/snowflake";
import { effectiveLevel, isMutedAt, type NotifyLocalState } from "./decide";

export interface UnreadSummary {
  /** Total unread @mentions in channels that are not muted. */
  mentions: number;
  /** Something unread that is worth a dot (not muted, level not "only mentions" / "nothing"). */
  unread: boolean;
}

/** Counts what the user should be told about. Muted channels, categories and servers contribute nothing. */
export function summarizeUnread(state: Pick<AppState, "channels" | "readStates">, local: NotifyLocalState, now: number): UnreadSummary {
  let mentions = 0;
  let unread = false;
  for (const channel of Object.values(state.channels)) {
    if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildCategory) continue;
    const scopes = [channel.id, channel.parent_id, channel.guild_id].filter((id): id is string => !!id);
    if (scopes.some(id => isMutedAt(local, id, now))) continue;
    const level = effectiveLevel(local, scopes);
    if (level === "none") continue;
    const read = state.readStates[channel.id];
    mentions += read?.mention_count ?? 0;
    if (!unread && (level === "all" || level === "unreads-mentions") && channel.last_message_id) {
      if (!read?.last_message_id || compareIds(channel.last_message_id, read.last_message_id) > 0) unread = true;
    }
  }
  return { mentions, unread };
}

const countText = (n: number): string => (n > 99 ? "99+" : String(n));

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
export function formatTitle(base: string, summary: UnreadSummary, label?: string | null): string {
  const name = label ? `${base} | ${label}` : base;
  if (summary.mentions > 0) return `(${countText(summary.mentions)}) ${name}`;
  if (summary.unread) return `• ${name}`;
  return name;
}

/** Our own icon with a badge: red with the count for mentions, a plain white dot for unread. */
export function faviconSvg(summary: UnreadSummary): string {
  const base = iconSvg.trim().replace(/<\/svg>\s*$/, "");
  let badge = "";
  if (summary.mentions > 0) {
    const label = summary.mentions > 9 ? "9+" : String(summary.mentions);
    badge = `<circle cx="384" cy="128" r="128" fill="#f23f42"/><text x="384" y="${label.length > 1 ? 178 : 184}" font-family="sans-serif" font-weight="700" font-size="${label.length > 1 ? 130 : 170}" text-anchor="middle" fill="#fff">${label}</text>`;
  } else if (summary.unread) {
    badge = `<circle cx="392" cy="120" r="96" fill="#fff"/><circle cx="392" cy="120" r="64" fill="#f23f42"/>`;
  }
  return `${base}${badge}</svg>`;
}

let faviconLink: HTMLLinkElement | null = null;
let lastFavicon = "";
let baseTitle = "";
let lastBadge = -1;

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

/** Tauri only (macOS / Linux dock badge); Windows has no numeric badge API and rejects, which is fine. */
async function setWindowBadge(count: number): Promise<void> {
  if (!isTauri() || count === lastBadge) return;
  lastBadge = count;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined);
  } catch {
    /* unsupported platform */
  }
}

/** Applies the summary everywhere. `enabled` is the "unread badge" preference. */
export function applyUnread(summary: UnreadSummary, enabled: boolean, label: string | null = null): void {
  if (typeof document === "undefined") return;
  if (!baseTitle) baseTitle = document.title || "Vokko";
  const shown: UnreadSummary = enabled ? summary : { mentions: 0, unread: false };
  const title = formatTitle(baseTitle, shown, label);
  if (document.title !== title) document.title = title;
  setFavicon(faviconSvg(shown));
  void setWindowBadge(shown.mentions);
  void setTrayUnread(shown.unread || shown.mentions > 0);
}
