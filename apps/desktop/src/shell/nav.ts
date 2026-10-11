// Imperative navigation for code outside React components (actions, modals). Set once by <NavigatorBridge/>.

type Navigate = (to: string, options?: { replace?: boolean }) => void;

let navigateImpl: Navigate | null = null;

export function setNavigator(fn: Navigate | null): void {
  navigateImpl = fn;
}

export function go(to: string, options?: { replace?: boolean }): void {
  navigateImpl?.(to, options);
}

export const dmPath = (channelId?: string) => (channelId ? `/channels/@me/${channelId}` : "/channels/@me");
export const guildPath = (guildId: string, channelId?: string) => (channelId ? `/channels/${guildId}/${channelId}` : `/channels/${guildId}`);
