import { Search } from "lucide-react";
import { ApiRequestError } from "../../api/errors";
import { appStore, sortRoles } from "../../api/store";
import type { GuildMember, Role, Snowflake } from "../../api/types";

/** Helpers shared by the server settings people pages (members, roles, bans). */

export function roleColor(role: Pick<Role, "color">): string {
  return role.color === 0 ? "var(--text-muted)" : `#${role.color.toString(16).padStart(6, "0")}`;
}

export function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "Something went wrong. Try again.";
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange(next: string): void; placeholder: string }) {
  return (
    <div className="ss-search">
      <Search size={16} aria-hidden="true" />
      <input type="search" className="ss-search-input" placeholder={placeholder} aria-label={placeholder} value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

/** Replace / insert roles (by id) in the guild's role list. Idempotent with the gateway events. */
export function upsertRoles(guildId: Snowflake, roles: Role[]): void {
  const state = appStore.getState();
  const guild = state.guilds[guildId];
  if (!guild) return;
  const byId = new Map(guild.roles.map(r => [r.id, r]));
  for (const role of roles) byId.set(role.id, role);
  appStore.setState({ guilds: { ...state.guilds, [guildId]: { ...guild, roles: sortRoles([...byId.values()]) } } });
}

export function removeRoleLocal(guildId: Snowflake, roleId: Snowflake): void {
  const state = appStore.getState();
  const guild = state.guilds[guildId];
  if (!guild) return;
  const members = state.members[guildId] ?? {};
  const nextMembers: Record<Snowflake, GuildMember> = {};
  for (const [id, m] of Object.entries(members)) nextMembers[id] = m.roles.includes(roleId) ? { ...m, roles: m.roles.filter(r => r !== roleId) } : m;
  appStore.setState({
    guilds: { ...state.guilds, [guildId]: { ...guild, roles: guild.roles.filter(r => r.id !== roleId) } },
    members: { ...state.members, [guildId]: nextMembers },
  });
}

export function mergeMemberLocal(guildId: Snowflake, member: GuildMember): void {
  const state = appStore.getState();
  appStore.setState({ members: { ...state.members, [guildId]: { ...state.members[guildId], [member.user.id]: member } } });
}
