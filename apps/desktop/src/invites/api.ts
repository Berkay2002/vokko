// Invite REST calls and the option lists the invite UI offers (docs/api.md "Invites and user settings").

import { request } from "../api/rest";
import type { Channel, CreateInviteRequest, InviteMaxAge, InviteMaxUses, InviteMetadata, Message, Snowflake } from "../api/types";

export const MAX_AGE_OPTIONS: { value: InviteMaxAge; label: string }[] = [
  { value: 1800, label: "30 minutes" },
  { value: 3600, label: "1 hour" },
  { value: 21_600, label: "6 hours" },
  { value: 43_200, label: "12 hours" },
  { value: 86_400, label: "1 day" },
  { value: 604_800, label: "7 days" },
  { value: 0, label: "Never" },
];

export const MAX_USES_OPTIONS: { value: InviteMaxUses; label: string }[] = [
  { value: 0, label: "No limit" },
  { value: 1, label: "1 use" },
  { value: 5, label: "5 uses" },
  { value: 10, label: "10 uses" },
  { value: 25, label: "25 uses" },
  { value: 50, label: "50 uses" },
  { value: 100, label: "100 uses" },
];

export interface InviteSettings {
  maxAge: InviteMaxAge;
  maxUses: InviteMaxUses;
  temporary: boolean;
}

export const DEFAULT_INVITE_SETTINGS: InviteSettings = { maxAge: 604_800, maxUses: 0, temporary: false };

export const inviteLink = (code: string): string => `vokko.gg/${code}`;

export function createInvite(channelId: Snowflake, settings: InviteSettings, unique = false): Promise<InviteMetadata> {
  const body: CreateInviteRequest = { max_age: settings.maxAge, max_uses: settings.maxUses, temporary: settings.temporary, unique };
  return request<InviteMetadata>("POST", `/channels/${channelId}/invites`, body);
}

export const listGuildInvites = (guildId: Snowflake): Promise<InviteMetadata[]> => request("GET", `/guilds/${guildId}/invites`);
export const listChannelInvites = (channelId: Snowflake): Promise<InviteMetadata[]> => request("GET", `/channels/${channelId}/invites`);
export const revokeInvite = (code: string): Promise<InviteMetadata> => request("DELETE", `/invites/${encodeURIComponent(code)}`);

/** Sends the invite link to a friend as a DM (opening the DM if needed, without navigating). */
export async function sendInviteToFriend(userId: Snowflake, code: string): Promise<Message> {
  const channel = await request<Channel>("POST", "/users/@me/channels", { recipient_id: userId });
  return request<Message>("POST", `/channels/${channel.id}/messages`, { content: `https://${inviteLink(code)}` });
}

/** "Your invite link expires in 7 days." style text for the modal footer. */
export function expiryText(settings: InviteSettings): string {
  const age = MAX_AGE_OPTIONS.find(o => o.value === settings.maxAge)?.label ?? "";
  const expires = settings.maxAge === 0 ? "Your invite link will never expire" : `Your invite link expires in ${age}`;
  return settings.maxUses > 0 ? `${expires} or after ${settings.maxUses} ${settings.maxUses === 1 ? "use" : "uses"}.` : `${expires}.`;
}

/** Time left until `expiresAt` as "6d 23h", "4h 12m", "12m", or "∞" for invites that never expire. */
export function timeLeft(expiresAt: string | null, now = Date.now()): string {
  if (!expiresAt) return "∞";
  const minutes = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}
