import { useMemo, useState } from "react";
import { Clock, MoreHorizontal, Plus } from "lucide-react";
import { canEditRole } from "../../api/permissions";
import { request } from "../../api/rest";
import { displayName, useStore } from "../../api/store";
import type { Guild, GuildMember, Role } from "../../api/types";
import { useContextMenu, type MenuItem } from "../../ui";
import { useModerationRights } from "../usePermissions";
import { Avatar } from "../Avatar";
import { openModal } from "../modalStore";
import { Page, Select } from "./controls";
import { SearchBox, errorText, mergeMemberLocal, roleColor } from "./shared";

export { roleColor };

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function RoleChip({ role }: { role: Role }) {
  return (
    <span className="ss-role-chip">
      <span className="ss-role-dot" style={{ background: roleColor(role) }} />
      {role.name}
    </span>
  );
}

function MemberRow({ guild, member, onError }: { guild: Guild; member: GuildMember; onError(message: string | null): void }) {
  const userId = member.user.id;
  const meId = useStore(s => s.me?.id) ?? "";
  const actorMember = useStore(s => s.members[guild.id]?.[meId]);
  const rights = useModerationRights(guild.id, userId);
  const menu = useContextMenu();
  const rolesById = new Map(guild.roles.map(r => [r.id, r]));
  const roles = member.roles.map(id => rolesById.get(id)).filter((r): r is Role => !!r && r.id !== guild.id);
  const actor = { id: meId, roles: actorMember?.roles ?? [] };
  const assignable = guild.roles.filter(r => r.id !== guild.id && canEditRole(guild, actor, r)).sort((a, b) => b.position - a.position);
  const timedOut = !!member.communication_disabled_until && Date.parse(member.communication_disabled_until) > Date.now();

  const toggleRole = async (role: Role) => {
    const next = member.roles.includes(role.id) ? member.roles.filter(r => r !== role.id) : [...member.roles, role.id];
    onError(null);
    try {
      mergeMemberLocal(guild.id, await request<GuildMember>("PATCH", `/guilds/${guild.id}/members/${userId}`, { roles: next }));
    } catch (e) {
      onError(errorText(e));
    }
  };

  const roleItems = (): MenuItem[] =>
    assignable.map(role => ({ id: `role-${role.id}`, label: role.name, checked: member.roles.includes(role.id), onSelect: () => void toggleRole(role) }));

  const showRoles = (e: { clientX: number; clientY: number }) => menu.open(e, roleItems());

  const showActions = (e: { clientX: number; clientY: number }) => {
    const items: MenuItem[] = [];
    if (rights.kick) items.push({ id: "kick", label: "Kick", danger: true, onSelect: () => openModal({ type: "kickMember", guildId: guild.id, userId }) });
    if (rights.ban) items.push({ id: "ban", label: "Ban", danger: true, onSelect: () => openModal({ type: "banMember", guildId: guild.id, userId }) });
    if (rights.timeout) items.push({ id: "timeout", label: "Timeout", onSelect: () => openModal({ type: "timeoutMember", guildId: guild.id, userId }) });
    if (rights.nickname) items.push({ id: "nickname", label: "Change Nickname", onSelect: () => openModal({ type: "nickname", guildId: guild.id, userId }) });
    if (rights.roles && assignable.length > 0) items.push({ id: "roles", label: "Roles", children: roleItems() });
    menu.open(e, items);
  };

  return (
    <tr>
      <td>
        <div className="ss-member-name">
          <Avatar user={member.user} size={32} />
          <div className="ss-member-text">
            <span className="ss-member-display">{displayName(member.user, member)}</span>
            <span className="ss-member-username">{member.user.username}</span>
          </div>
          {timedOut && (
            <span className="ss-timeout-tag" title="Timed out">
              <Clock size={12} aria-hidden="true" /> Timed out
            </span>
          )}
        </div>
      </td>
      <td>{formatDate(member.joined_at)}</td>
      <td>
        <div className="ss-chip-row">
          {roles.map(r => (
            <RoleChip key={r.id} role={r} />
          ))}
          {rights.roles && assignable.length > 0 && (
            <button type="button" className="ss-chip-add" aria-label={`Edit roles for ${member.user.username}`} onClick={e => showRoles({ clientX: e.clientX, clientY: e.clientY })}>
              <Plus size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </td>
      <td className="ss-actions-cell">
        {rights.any && (
          <button type="button" className="ss-icon-btn" aria-label={`Actions for ${member.user.username}`} aria-haspopup="menu" onClick={e => showActions({ clientX: e.clientX, clientY: e.clientY })}>
            <MoreHorizontal size={18} aria-hidden="true" />
          </button>
        )}
      </td>
    </tr>
  );
}

type MemberSort = "newest" | "oldest";

export function MembersPage({ guild, members }: { guild: Guild; members: Record<string, GuildMember> | undefined }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<MemberSort>("newest");
  const [error, setError] = useState<string | null>(null);
  const all = useMemo(() => Object.values(members ?? {}), [members]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? all.filter(m => m.user.id === needle || m.user.username.toLowerCase().includes(needle) || (m.user.global_name ?? "").toLowerCase().includes(needle) || (m.nick ?? "").toLowerCase().includes(needle))
      : all;
    const dir = sort === "newest" ? -1 : 1;
    return [...filtered].sort((a, b) => dir * (Date.parse(a.joined_at) - Date.parse(b.joined_at)));
  }, [all, query, sort]);

  return (
    <Page title="Members">
      <div className="ss-toolbar">
        <SearchBox value={query} onChange={setQuery} placeholder="Search by username or id" />
        <div className="ss-sort">
          <Select<MemberSort>
            label="Sort by Member Since"
            value={sort}
            onChange={setSort}
            options={[
              { value: "newest", label: "Member Since (Newest)" },
              { value: "oldest", label: "Member Since (Oldest)" },
            ]}
          />
        </div>
      </div>
      {error && <p className="field-error">{error}</p>}
      <div className="ss-count" aria-live="polite">
        {rows.length} {rows.length === 1 ? "Member" : "Members"}
      </div>
      <table className="ss-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Member Since</th>
            <th scope="col">Roles</th>
            <th scope="col" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map(m => (
            <MemberRow key={m.user.id} guild={guild} member={m} onError={setError} />
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="settings-todo">No members match your search.</p>}
    </Page>
  );
}
