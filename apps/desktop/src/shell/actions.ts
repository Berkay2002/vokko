// User-initiated API actions of the shell. State comes back through gateway events; these helpers also wait for
// the event (or fall back to the REST response) so navigation after "create" lands on a known entity.

import { getOwnActivities } from "../activity/own";
import { isDmRefused } from "../api/errors";
import { gateway } from "../api/gateway";
import { request } from "../api/rest";
import { appStore, isChannelUnread, type AppState } from "../api/store";
import { isDesktop } from "../desktop";
import { ChannelType, GatewayOp, type Activity, type Channel, type Guild, type PermissionOverwrite, type PresenceStatus, type Snowflake } from "../api/types";
import { isApplyRequired } from "./inviteView";
import { openModal } from "./modalStore";
import { dmPath, go, guildPath } from "./nav";
import { firstTextChannel } from "./channels";
import type { ServerTemplate } from "./templates";

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

/** Adds a template's channels to a freshly created guild (sequential: positions follow creation order). */
async function seedTemplate(guildId: Snowflake, template: ServerTemplate): Promise<void> {
  const channels = await request<Channel[]>("GET", `/guilds/${guildId}/channels`);
  const category = (name: string) => channels.find(c => c.type === ChannelType.GuildCategory && c.name === name)?.id ?? null;
  const make = (name: string, type: ChannelType, parent: Snowflake | null) => request<Channel>("POST", `/guilds/${guildId}/channels`, { name, type, ...(parent ? { parent_id: parent } : {}) });
  for (const extra of template.categories ?? []) {
    const parent = await make(extra.name, ChannelType.GuildCategory, null);
    for (const name of extra.text) await make(name, ChannelType.GuildText, parent.id);
  }
  for (const name of template.text) await make(name, ChannelType.GuildText, category("Text Channels"));
  for (const name of template.voice) await make(name, ChannelType.GuildVoice, category("Voice Channels"));
}

export async function createGuild(name: string, iconAttachmentId?: Snowflake, template?: ServerTemplate): Promise<Guild> {
  const guild = await request<Guild>("POST", "/guilds", { name, ...(iconAttachmentId ? { icon_attachment_id: iconAttachmentId } : {}) });
  await waitFor(s => s.guilds[guild.id]);
  if (template) await seedTemplate(guild.id, template).catch(() => undefined);
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

/** Joins with an invite, or opens the Apply to Join dialog (and resolves null) when the server takes applications. */
export async function joinOrApply(code: string): Promise<Guild | null> {
  try {
    return await joinGuildWithInvite(code);
  } catch (e) {
    if (!isApplyRequired(e)) throw e;
    openModal({ type: "applyToJoin", code: code.trim().replace(/^.*\//, "") });
    return null;
  }
}

export async function createChannel(guildId: Snowflake, input: { name: string; type: ChannelType; parent_id?: Snowflake | null; topic?: string; permission_overwrites?: PermissionOverwrite[] }): Promise<Channel> {
  const channel = await request<Channel>("POST", `/guilds/${guildId}/channels`, input);
  await waitFor(s => s.channels[channel.id]);
  if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildCategory) go(guildPath(guildId, channel.id));
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

/** Open (or create) the DM with `userId` and navigate to it. */
/** Opens (or creates) the DM and navigates to it; undefined when the other side refuses DMs. */
export async function openDirectMessage(userId: Snowflake): Promise<Channel | undefined> {
  try {
    const channel = await request<Channel>("POST", "/users/@me/channels", { recipient_id: userId });
    appStore.getState().upsertChannel(channel);
    go(dmPath(channel.id));
    return channel;
  } catch (e) {
    if (!isDmRefused(e)) throw e;
    openModal({ type: "dmRefused" });
    return undefined;
  }
}

export async function createGroupDM(userIds: Snowflake[]): Promise<void> {
  if (userIds.length === 1 && userIds[0]) return void (await openDirectMessage(userIds[0]));
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

export function markGuildRead(guildId: Snowflake): Promise<void> {
  return markGuildsRead([guildId]);
}

/** Mark every unread channel of these guilds read with as few bulk acks as possible (100 entries per request). */
export async function markGuildsRead(guildIds: readonly Snowflake[]): Promise<void> {
  const state = appStore.getState();
  const wanted = new Set(guildIds);
  const read_states = Object.values(state.channels)
    .filter(c => c.guild_id != null && wanted.has(c.guild_id) && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement || c.type === ChannelType.GuildVoice) && c.last_message_id && isChannelUnread(state, c.id))
    .map(c => ({ channel_id: c.id, message_id: c.last_message_id as Snowflake }));
  for (let i = 0; i < read_states.length; i += 100) await request<void>("POST", "/read-states/ack-bulk", { read_states: read_states.slice(i, i + 100) });
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
  // Op 3 keeps every field it leaves out. Only the desktop app detects games, so only it sends `activities` (with every
  // status change, so a reconnect cannot lose them). A browser session sending `[]` would otherwise hide the game that the
  // desktop app of the same account reported.
  const presence: { status: PresenceStatus; custom_status: string | null; activities?: Activity[] } = { status: wire, custom_status: custom.trim() || null };
  if (isDesktop()) presence.activities = getOwnActivities();
  gateway.send(GatewayOp.PresenceUpdate, presence);
}

/** Sends the stored status again, e.g. after the detected game changed. */
export function resendOwnStatus(): void {
  const { status, custom } = loadStoredStatus();
  setOwnStatus(status, custom);
}

/** Copy text to the clipboard; a missing or denied clipboard is not worth surfacing. */
export const copyText = (text: string): void => void navigator.clipboard?.writeText(text).catch(() => {});
