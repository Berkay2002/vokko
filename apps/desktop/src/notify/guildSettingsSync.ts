// Notification settings and mutes synced per account (docs/api.md "Notification settings"): the server's user guild settings
// (READY `user_guild_settings`, USER_GUILD_SETTINGS_UPDATE, PATCH /users/@me/guilds/{guild.id|@me}/settings) fill the local cache
// `useLocalState`, and every local change to a guild, channel, category or DM is PATCHed. Ids the cache holds that are none of
// those (thread mutes, deleted channels) stay local. A device's first sync uploads what older builds kept per device.

import { gateway } from "../api/gateway";
import { request } from "../api/rest";
import { appStore } from "../api/store";
import { UNREADS_ONLY_MENTIONS, type MessageNotificationLevel, type MuteConfig, type ReadyEvent, type Snowflake, type UpdateUserGuildSettingsRequest, type UserGuildSettings } from "../api/types";
import { FOREVER, useLocalState, type LocalState, type NotifyLevel } from "../shell/localState";

/** Where an id's settings live: its guild ("@me" for DMs), as the guild itself or as a channel override. */
interface Scope {
  guild: string;
  channel: boolean;
}

const known = new Map<Snowflake, Scope>();

/** The scope of a guild, guild channel/category or DM channel id; null for anything else (threads, unknown ids). */
export function scopeOf(id: Snowflake): Scope | null {
  const cached = known.get(id);
  if (cached) return cached;
  const { guilds, channels, privateChannels } = appStore.getState();
  if (guilds[id]) return { guild: id, channel: false };
  const channel = channels[id];
  if (channel?.guild_id) return { guild: channel.guild_id, channel: true };
  if (channel || privateChannels.includes(id)) return { guild: "@me", channel: true };
  return null;
}

/** Scopes from READY itself (its listener may run before the app store has applied it). */
function learn(ready: ReadyEvent): void {
  known.clear();
  for (const guild of ready.guilds) {
    known.set(guild.id, { guild: guild.id, channel: false });
    for (const channel of guild.channels) known.set(channel.id, { guild: guild.id, channel: true });
  }
  for (const channel of ready.private_channels) known.set(channel.id, { guild: "@me", channel: true });
}

const LEVEL_OUT: Record<NotifyLevel, [MessageNotificationLevel, number]> = {
  default: [3, 0],
  all: [0, 0],
  "unreads-mentions": [1, UNREADS_ONLY_MENTIONS],
  mentions: [1, 0],
  none: [2, 0],
};

function levelIn(level: MessageNotificationLevel, flags: number): NotifyLevel {
  if (level === 0) return "all";
  if (level === 1) return flags & UNREADS_ONLY_MENTIONS ? "unreads-mentions" : "mentions";
  if (level === 2) return "none";
  return "default";
}

function muteOut(until: number | undefined): { muted: boolean; mute_config: MuteConfig | null } {
  if (until === undefined) return { muted: false, mute_config: null };
  return { muted: true, mute_config: until === FOREVER ? null : { end_time: new Date(until).toISOString() } };
}

const muteIn = (muted: boolean, config: MuteConfig | null): number | undefined =>
  !muted ? undefined : config?.end_time ? Date.parse(config.end_time) : FOREVER;

type Maps = Pick<LocalState, "mutedUntil" | "notify" | "hideMuted" | "suppressEveryone" | "suppressRoles">;
const MAP_KEYS = ["mutedUntil", "notify", "hideMuted", "suppressEveryone", "suppressRoles"] as const;

/** Comparable value of one map entry (absent, false and "default" are the same thing). */
function norm(state: Maps, key: (typeof MAP_KEYS)[number], id: Snowflake): unknown {
  if (key === "mutedUntil") return state.mutedUntil[id];
  if (key === "notify") return state.notify[id] ?? "default";
  return !!state[key][id];
}

/** The PATCH bodies (by guild path segment) that bring the server from `prev` to `next`, for ids `include` accepts. */
export function patchesBetween(prev: Maps, next: Maps, include: (id: Snowflake, scope: Scope) => boolean = () => true): Map<string, UpdateUserGuildSettingsRequest> {
  const patches = new Map<string, UpdateUserGuildSettingsRequest>();
  const ids = new Set(MAP_KEYS.flatMap(key => [...Object.keys(prev[key]), ...Object.keys(next[key])]));
  for (const id of ids) {
    if (MAP_KEYS.every(key => norm(prev, key, id) === norm(next, key, id))) continue;
    const scope = scopeOf(id);
    if (!scope || !include(id, scope)) continue;
    const patch = patches.get(scope.guild) ?? {};
    const [message_notifications, flags] = LEVEL_OUT[next.notify[id] ?? "default"];
    const fields = { ...muteOut(next.mutedUntil[id]), message_notifications, flags };
    if (scope.channel) patch.channel_overrides = { ...patch.channel_overrides, [id]: fields };
    else Object.assign(patch, fields, { suppress_everyone: !!next.suppressEveryone[id], suppress_roles: !!next.suppressRoles[id], hide_muted_channels: !!next.hideMuted[id] });
    patches.set(scope.guild, patch);
  }
  return patches;
}

/** `state` with every id whose scope `replace` accepts dropped and `entries` written in. */
export function withEntries(state: Maps, entries: readonly UserGuildSettings[], replace: (guild: string) => boolean): Maps {
  const next = Object.fromEntries(MAP_KEYS.map(key => [key, { ...state[key] }])) as unknown as Maps;
  for (const key of MAP_KEYS) {
    for (const id of Object.keys(next[key])) {
      const scope = scopeOf(id);
      if (scope && replace(scope.guild)) delete next[key][id];
    }
  }
  const put = (id: Snowflake, muted: boolean, config: MuteConfig | null, level: MessageNotificationLevel, flags: number) => {
    const until = muteIn(muted, config);
    if (until !== undefined) next.mutedUntil[id] = until;
    const notify = levelIn(level, flags);
    if (notify !== "default") next.notify[id] = notify;
  };
  for (const entry of entries) {
    if (entry.guild_id !== null) {
      const id = entry.guild_id;
      put(id, entry.muted, entry.mute_config, entry.message_notifications, entry.flags);
      if (entry.suppress_everyone) next.suppressEveryone[id] = true;
      if (entry.suppress_roles) next.suppressRoles[id] = true;
      if (entry.hide_muted_channels) next.hideMuted[id] = true;
    }
    for (const o of entry.channel_overrides) put(o.channel_id, o.muted, o.mute_config, o.message_notifications, o.flags);
  }
  return next;
}

const SYNCED_FOR_KEY = "vokko.notify.syncedFor";
const EMPTY: Maps = { mutedUntil: {}, notify: {}, hideMuted: {}, suppressEveryone: {}, suppressRoles: {} };

function readSyncedFor(): string | null {
  try {
    return localStorage.getItem(SYNCED_FOR_KEY);
  } catch {
    return null;
  }
}

function writeSyncedFor(id: string): void {
  try {
    localStorage.setItem(SYNCED_FOR_KEY, id);
  } catch {
    /* storage unavailable: the next READY uploads again, which only re-sends what the server already has */
  }
}

let active = false;
let applying = false;

function apply(entries: readonly UserGuildSettings[], replace: (guild: string) => boolean): void {
  applying = true;
  try {
    useLocalState.setState(state => withEntries(state, entries, replace));
  } finally {
    applying = false;
  }
}

const send = (guild: string, body: UpdateUserGuildSettingsRequest) => request<UserGuildSettings>("PATCH", `/users/@me/guilds/${guild}/settings`, body);

/** READY: the server's entries replace the cache; a device that never synced first uploads its values for guilds the account has none for. */
export async function onReady(ready: ReadyEvent): Promise<void> {
  learn(ready);
  active = true;
  const entries = ready.user_guild_settings ?? [];
  const firstSync = readSyncedFor() === null;
  const saved = new Set(entries.map(entry => entry.guild_id ?? "@me"));
  const now = Date.now();
  const local = useLocalState.getState();
  const live = { ...local, mutedUntil: Object.fromEntries(Object.entries(local.mutedUntil).filter(([, until]) => until === FOREVER || until > now)) };
  const uploads = firstSync ? patchesBetween(EMPTY, live, (_, scope) => !saved.has(scope.guild)) : new Map<string, UpdateUserGuildSettingsRequest>();
  apply(entries, guild => !firstSync || saved.has(guild));
  const results = await Promise.allSettled([...uploads].map(([guild, body]) => send(guild, body)));
  if (results.every(result => result.status === "fulfilled")) writeSyncedFor(ready.user.id);
  else console.warn("[notify] could not upload this device's notification settings; retrying at the next connect");
}

let wired = false;

export function wireGuildSettingsSync(): void {
  if (wired) return;
  wired = true;
  gateway.on("READY", ready => void onReady(ready));
  gateway.on("USER_GUILD_SETTINGS_UPDATE", entry => apply([entry], guild => guild === (entry.guild_id ?? "@me")));
  let last = useLocalState.getState();
  useLocalState.subscribe(state => {
    const prev = last;
    last = state;
    if (applying || !active) return;
    // ponytail: a failed PATCH is only logged; the next READY or update brings the server's value back.
    for (const [guild, body] of patchesBetween(prev, state)) send(guild, body).catch(error => console.warn("[notify] could not save notification settings", error));
  });
  let me = appStore.getState().me?.id ?? null;
  appStore.subscribe(state => {
    const next = state.me?.id ?? null;
    if (next !== me && next === null) active = false;
    me = next;
  });
}

wireGuildSettingsSync();
