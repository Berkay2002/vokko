// User-initiated API actions of the shell. State comes back through gateway events; these helpers also wait for
// the event (or fall back to the REST response) so navigation after "create" lands on a known entity.

import { gateway } from "../api/gateway";
import { request } from "../api/rest";
import { appStore, type AppState } from "../api/store";
import { ChannelType, GatewayOp, type Channel, type Guild, type PresenceStatus, type Snowflake } from "../api/types";
import { dmPath, go, guildPath } from "./nav";
import { firstTextChannel } from "./channels";

function waitFor<T>(read: (s: AppState) => T | undefined, timeoutMs = 2500): Promise<T | undefined> {
  const now = read(appStore.getState());
  if (now !== undefined) return Promise.resolve(now);
  return new Promise(resolve => {
    const done = (value: T | undefined) => {
      unsubscribe();
      clearTimeout(timer);
      resolve(value);
    };
    const unsubscribe = appStore.subscribe(state => {
      const value = read(state);
      if (value !== undefined) done(value);
    });
    const timer = setTimeout(() => done(undefined), timeoutMs);
  });
}

export async function createGuild(name: string, iconAttachmentId?: Snowflake): Promise<Guild> {
  const guild = await request<Guild>("POST", "/guilds", { name, ...(iconAttachmentId ? { icon_attachment_id: iconAttachmentId } : {}) });
  await waitFor(s => s.guilds[guild.id]);
  const channels = Object.values(appStore.getState().channels).filter(c => c.guild_id === guild.id);
  const target = firstTextChannel(channels);
  go(target ? guildPath(guild.id, target.id) : guildPath(guild.id));
  return guild;
}

export async function joinGuildWithInvite(code: string): Promise<Guild> {
  const cleaned = code.trim().replace(/^.*\//, "");
  const guild = await request<Guild>("POST", `/invites/${encodeURIComponent(cleaned)}`);
  await waitFor(s => s.guilds[guild.id]);
  go(guildPath(guild.id));
  return guild;
}

export async function createChannel(guildId: Snowflake, input: { name: string; type: ChannelType; parent_id?: Snowflake | null; topic?: string }): Promise<Channel> {
  const channel = await request<Channel>("POST", `/guilds/${guildId}/channels`, input);
  await waitFor(s => s.channels[channel.id]);
  if (channel.type === ChannelType.GuildText) go(guildPath(guildId, channel.id));
  return channel;
}

export async function leaveGuild(guildId: Snowflake): Promise<void> {
  await request<void>("DELETE", `/users/@me/guilds/${guildId}`);
  appStore.getState().removeGuild(guildId);
  go(dmPath());
}

export async function deleteGuild(guildId: Snowflake): Promise<void> {
  await request<void>("DELETE", `/guilds/${guildId}`);
  appStore.getState().removeGuild(guildId);
  go(dmPath());
}

export interface Invite {
  code: string;
  expires_at: string | null;
}

export function createInvite(channelId: Snowflake, maxAgeSeconds = 86_400): Promise<Invite> {
  return request<Invite>("POST", `/channels/${channelId}/invites`, { max_age: maxAgeSeconds });
}

/** Open (or create) the DM with `userId` and navigate to it. */
export async function openDirectMessage(userId: Snowflake): Promise<void> {
  const channel = await request<Channel>("POST", "/users/@me/channels", { recipient_id: userId });
  appStore.getState().upsertChannel(channel);
  go(dmPath(channel.id));
}

export async function createGroupDM(userIds: Snowflake[]): Promise<void> {
  if (userIds.length === 1 && userIds[0]) return openDirectMessage(userIds[0]);
  const channel = await request<Channel>("POST", "/users/@me/channels", { recipient_ids: userIds });
  appStore.getState().upsertChannel(channel);
  go(dmPath(channel.id));
}

export async function closeDirectMessage(channelId: Snowflake): Promise<void> {
  await request<Channel>("DELETE", `/channels/${channelId}`);
  appStore.getState().removeChannel(channelId);
  if (appStore.getState().route.channelId === channelId) go(dmPath());
}

/** Mark a channel read up to its last message. */
export async function markChannelRead(channelId: Snowflake): Promise<void> {
  const channel = appStore.getState().channels[channelId];
  if (!channel?.last_message_id) return;
  await request<void>("POST", `/channels/${channelId}/messages/${channel.last_message_id}/ack`);
}

export async function markGuildRead(guildId: Snowflake): Promise<void> {
  const state = appStore.getState();
  const unread = Object.values(state.channels).filter(c => c.guild_id === guildId && c.type === ChannelType.GuildText && c.last_message_id);
  await Promise.all(unread.map(c => markChannelRead(c.id)));
}

// ---- own presence ----

export type SelectableStatus = "online" | "idle" | "dnd" | "invisible";
const STATUS_KEY = "vokko.status";

export function loadStoredStatus(): { status: SelectableStatus; custom: string } {
  try {
    const parsed = JSON.parse(localStorage.getItem(STATUS_KEY) ?? "null") as { status?: SelectableStatus; custom?: string } | null;
    return { status: parsed?.status ?? "online", custom: parsed?.custom ?? "" };
  } catch {
    return { status: "online", custom: "" };
  }
}

export function setOwnStatus(status: SelectableStatus, custom: string): void {
  try {
    localStorage.setItem(STATUS_KEY, JSON.stringify({ status, custom }));
  } catch {
    /* ignore */
  }
  const wire: PresenceStatus = status === "invisible" ? "offline" : status;
  gateway.send(GatewayOp.PresenceUpdate, { status: wire, custom_status: custom.trim() || null });
}
