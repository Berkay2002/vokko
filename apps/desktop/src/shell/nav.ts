// Imperative navigation for code outside React components (actions, modals). Set once by <NavigatorBridge/>.
import { inviteOrigin } from "../invites/api";

type Navigate = (to: string, options?: { replace?: boolean }) => void;

let navigateImpl: Navigate | null = null;

export function setNavigator(fn: Navigate | null): void {
  navigateImpl = fn;
}

export function go(to: string, options?: { replace?: boolean }): void {
  navigateImpl?.(to, options);
}

export const dmPath = (channelId?: string) => (channelId ? `/channels/@me/${channelId}` : "/channels/@me");
/** Shareable link to a message (`guildId` null for a DM); the SPA's /channels/:g/:c/:m route opens it. Desktop copies point at the API origin, not tauri://. */
export const messageLink = (guildId: string | null, channelId: string, messageId: string, origin: string = inviteOrigin()): string =>
  `${origin}/channels/${guildId ?? "@me"}/${channelId}/${messageId}`;
/** The in-app path of a link to one of this app's own messages (a pasted Copy Message Link), or null for any other URL. */
export function messagePathOf(href: string, origins: readonly string[] = [inviteOrigin(), typeof window === "undefined" ? "" : window.location.origin]): string | null {
  try {
    const url = new URL(href);
    return origins.includes(url.origin) && /^\/channels\/(@me|\d+)\/\d+\/\d+$/.test(url.pathname) ? url.pathname : null;
  } catch {
    return null;
  }
}
export const guildPath = (guildId: string, channelId?: string) => (channelId ? `/channels/${guildId}/${channelId}` : `/channels/${guildId}`);
