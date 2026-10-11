import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { displayName } from "../../api/store";
import type { Guild, GuildMember, Role } from "../../api/types";
import { Avatar } from "../Avatar";
import { Category, Divider, Page, Select, SwitchRow, Unavailable } from "./controls";
import { ADMINISTRATOR_BIT, PERMISSION_GROUPS, hasPermission } from "./permissions";

export function roleColor(role: Pick<Role, "color">): string {
  return role.color === 0 ? "var(--text-muted)" : `#${role.color.toString(16).padStart(6, "0")}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange(next: string): void; placeholder: string }) {
  return (
    <div className="ss-search">
      <Search size={16} aria-hidden="true" />
      <input type="search" className="ss-search-input" placeholder={placeholder} aria-label={placeholder} value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

function RoleChip({ role }: { role: Role }) {
  return (
    <span className="ss-role-chip">
      <span className="ss-role-dot" style={{ background: roleColor(role) }} />
      {role.name}
    </span>
  );
}

type MemberSort = "newest" | "oldest";

export function MembersPage({ guild, members }: { guild: Guild; members: Record<string, GuildMember> | undefined }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<MemberSort>("newest");
  const rolesById = useMemo(() => new Map(guild.roles.map(r => [r.id, r])), [guild.roles]);
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
      <div className="ss-count" aria-live="polite">
        {rows.length} {rows.length === 1 ? "Member" : "Members"}
      </div>
      <table className="ss-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Member Since</th>
            <th scope="col">Roles</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(m => {
            const roles = m.roles.map(id => rolesById.get(id)).filter((r): r is Role => !!r && r.id !== guild.id);
            return (
              <tr key={m.user.id}>
                <td>
                  <div className="ss-member-name">
                    <Avatar user={m.user} size={32} />
                    <div className="ss-member-text">
                      <span className="ss-member-display">{displayName(m.user, m)}</span>
                      <span className="ss-member-username">{m.user.username}</span>
                    </div>
                  </div>
                </td>
                <td>{formatDate(m.joined_at)}</td>
                <td>
                  <div className="ss-chip-row">
                    {roles.map(r => (
                      <RoleChip key={r.id} role={r} />
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <p className="settings-todo">No members match your search.</p>}
    </Page>
  );
}

type RoleTab = "display" | "permissions" | "links" | "members";

function RoleEditor({ guild, role, members, onBack }: { guild: Guild; role: Role; members: GuildMember[]; onBack(): void }) {
  const [tab, setTab] = useState<RoleTab>("display");
  const [permQuery, setPermQuery] = useState("");
  const isEveryone = role.id === guild.id;
  const holders = isEveryone ? members : members.filter(m => m.roles.includes(role.id));
  const isAdmin = hasPermission(role.permissions, ADMINISTRATOR_BIT);
  const tabs: { id: RoleTab; label: string }[] = [
    { id: "display", label: "Display" },
    { id: "permissions", label: "Permissions" },
    { id: "links", label: "Links" },
    { id: "members", label: `Manage Members (${holders.length})` },
  ];
  const needle = permQuery.trim().toLowerCase();
  const title = isEveryone ? "Default Permissions (@everyone)" : `Edit Role - ${role.name}`;

  return (
    <Page title={title}>
      <button type="button" className="btn btn-link btn-sm ss-back" onClick={onBack}>
        <ChevronLeft size={16} aria-hidden="true" /> Back to Roles
      </button>
      <div className="ss-tabs" role="tablist" aria-label="Role sections">
        {tabs.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`ss-tab${tab === t.id ? " selected" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <Unavailable>Editing roles is not available yet. This is a read-only view.</Unavailable>

      {tab === "display" && (
        <div role="tabpanel" aria-label="Display">
          <div className="settings-field">
            <div className="field-label">Role Name</div>
            <input className="input" value={role.name} readOnly disabled aria-label="Role Name" />
          </div>
          <div className="settings-field">
            <div className="field-label">Role Color</div>
            <div className="ss-color">
              <span className="ss-swatch" style={{ background: roleColor(role) }} aria-hidden="true" />
              <span className="ss-color-value">{role.color === 0 ? "Default" : roleColor(role)}</span>
            </div>
          </div>
          <Divider />
          <SwitchRow label="Display role members separately from online members" checked={role.hoist} onChange={() => undefined} disabled />
          <SwitchRow label="Allow anyone to @mention this role" checked={role.mentionable} onChange={() => undefined} disabled />
        </div>
      )}

      {tab === "permissions" && (
        <div role="tabpanel" aria-label="Permissions">
          <SearchBox value={permQuery} onChange={setPermQuery} placeholder="Search permissions" />
          {PERMISSION_GROUPS.map(g => {
            const visible = g.permissions.filter(p => !needle || p.label.toLowerCase().includes(needle));
            if (visible.length === 0) return null;
            return (
              <Category key={g.title} title={g.title}>
                {visible.map(p => (
                  <SwitchRow key={p.bit} label={p.label} checked={isAdmin || hasPermission(role.permissions, p.bit)} onChange={() => undefined} disabled />
                ))}
              </Category>
            );
          })}
        </div>
      )}

      {tab === "links" && (
        <div role="tabpanel" aria-label="Links">
          <Unavailable>Not available yet.</Unavailable>
        </div>
      )}

      {tab === "members" && (
        <div role="tabpanel" aria-label="Manage Members">
          {holders.length === 0 ? (
            <p className="settings-todo">No members have this role.</p>
          ) : (
            <ul className="ss-holder-list">
              {holders.map(m => (
                <li key={m.user.id} className="ss-member-name">
                  <Avatar user={m.user} size={32} />
                  <div className="ss-member-text">
                    <span className="ss-member-display">{displayName(m.user, m)}</span>
                    <span className="ss-member-username">{m.user.username}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Page>
  );
}

export function RolesPage({ guild, members }: { guild: Guild; members: Record<string, GuildMember> | undefined }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const memberList = useMemo(() => Object.values(members ?? {}), [members]);
  const everyone = guild.roles.find(r => r.id === guild.id);
  const roles = useMemo(() => guild.roles.filter(r => r.id !== guild.id).sort((a, b) => b.position - a.position), [guild.roles, guild.id]);
  const active = selected ? guild.roles.find(r => r.id === selected) : undefined;

  if (active) return <RoleEditor guild={guild} role={active} members={memberList} onBack={() => setSelected(null)} />;

  const needle = query.trim().toLowerCase();
  const visible = needle ? roles.filter(r => r.name.toLowerCase().includes(needle)) : roles;
  const countOf = (role: Role) => memberList.filter(m => m.roles.includes(role.id)).length;

  return (
    <Page title="Roles">
      <p className="settings-todo">Use roles to group your server members and assign permissions.</p>
      {everyone && (
        <button type="button" className="ss-role-row ss-role-default" onClick={() => setSelected(everyone.id)}>
          <div className="ss-role-row-text">
            <span className="ss-role-row-name">Default Permissions (@everyone)</span>
            <span className="ss-role-row-note">@everyone applies to all members of the server.</span>
          </div>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      )}
      <div className="ss-toolbar">
        <SearchBox value={query} onChange={setQuery} placeholder="Search Roles" />
        <button type="button" className="btn btn-primary btn-sm" disabled title="Not available yet">
          Create Role
        </button>
      </div>
      <div className="ss-count">Roles - {roles.length}</div>
      <div className="ss-role-list">
        {visible.map(role => (
          <button key={role.id} type="button" className="ss-role-row" onClick={() => setSelected(role.id)}>
            <span className="ss-role-dot" style={{ background: roleColor(role) }} aria-hidden="true" />
            <span className="ss-role-row-name">{role.name}</span>
            <span className="ss-role-row-count">{countOf(role)} {countOf(role) === 1 ? "member" : "members"}</span>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        ))}
      </div>
      {visible.length === 0 && <p className="settings-todo">No roles match your search.</p>}
    </Page>
  );
}
