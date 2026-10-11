// STUB (vokko-chat): state shape per the orchestrator's contract. Dropped at milestone A merge.
import { useSyncExternalStore } from 'react';
import type { Channel, Guild, GuildMember, Presence, ReadState, Relationship, Snowflake, User } from './types';

export interface AppState {
  me: User | null;
  guilds: Record<Snowflake, Guild>;
  channels: Record<Snowflake, Channel>;
  privateChannels: Snowflake[];
  presences: Record<Snowflake, Presence>;
  readStates: Record<Snowflake, ReadState>;
  members: Record<Snowflake, Record<Snowflake, GuildMember>>;
  relationships: Record<Snowflake, Relationship>;
  users: Record<Snowflake, User>;
}

let state: AppState = { me: null, guilds: {}, channels: {}, privateChannels: [], presences: {}, readStates: {}, members: {}, relationships: {}, users: {} };
const listeners = new Set<() => void>();

export function getState(): AppState { return state; }
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  listeners.forEach(l => l());
}
export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => selector(state));
}

export function displayName(user: User, member?: Pick<GuildMember, 'nick'> | null): string {
  return member?.nick || user.global_name || user.username;
}
export function roleColor(guildId: Snowflake, member: Pick<GuildMember, 'roles'> | null | undefined): string | null {
  const guild = state.guilds[guildId];
  if (!guild || !member) return null;
  const roles = guild.roles.filter(r => member.roles.includes(r.id) && r.color !== 0).sort((a, b) => b.position - a.position);
  const c = roles[0]?.color;
  return c ? `#${c.toString(16).padStart(6, '0')}` : null;
}
const BLOBS = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#eb459e', '#00a8fc'];
export function defaultAvatarUrl(userId: Snowflake): string {
  const color = BLOBS[Number(BigInt(userId) % BigInt(BLOBS.length))] ?? '#5865f2';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="${color}"/><path d="M40 20c8 0 14 6 14 14v6c0 9-6 18-14 18S26 49 26 40v-6c0-8 6-14 14-14z" fill="#fff" fill-opacity=".9"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
