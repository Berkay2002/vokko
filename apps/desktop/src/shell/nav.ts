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
export const guildPath = (guildId: string, channelId?: string) => (channelId ? `/channels/${guildId}/${channelId}` : `/channels/${guildId}`);
