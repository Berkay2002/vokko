import { useEffect, useMemo, useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { Perm, canEditRole, canModerate, memberLike } from "../../api/permissions";
import { request } from "../../api/rest";
import { displayName, useStore } from "../../api/store";
import type { Guild, GuildMember, Role } from "../../api/types";
import { Modal, useContextMenu, type MenuItem } from "../../ui";
import { useModerationRights, usePermissions } from "../usePermissions";
import { Avatar } from "../Avatar";
import { openModal } from "../modalStore";
import { Page, Select } from "./controls";
import { SearchBox, errorText, mergeMemberLocal, roleColor } from "./shared";
import { BAN_HISTORY_OPTIONS, accountCreatedAt, fetchPruneCount, filterMembers, memberSignals, prune, sortMembers, type MemberSortKey, type SortDirection } from "./admin";

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

function MemberRow({ guild, member, onError, selected, selectable, onToggle }: { guild: Guild; member: GuildMember; onError(message: string | null): void; selected: boolean; selectable: boolean; onToggle(): void }) {
  const userId = member.user.id;
  const meId = useStore(s => s.me?.id) ?? "";
  const actorMember = useStore(s => s.members[guild.id]?.[meId]);
  const rights = useModerationRights(guild.id, userId);
  const menu = useContextMenu();
  const rolesById = new Map(guild.roles.map(r => [r.id, r]));
  const roles = member.roles.map(id => rolesById.get(id)).filter((r): r is Role => !!r && r.id !== guild.id);
  const actor = { id: meId, roles: actorMember?.roles ?? [] };
  const assignable = guild.roles.filter(r => r.id !== guild.id && canEditRole(guild, actor, r)).sort((a, b) => b.position - a.position);

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

  const signals = memberSignals(member, guild.owner_id);
  return (
    <tr className={selected ? "selected" : undefined}>
      <td className="ss-check-cell">
        <input type="checkbox" aria-label={`Select ${member.user.username}`} checked={selected} disabled={!selectable} onChange={onToggle} />
      </td>
      <td>
        <div className="ss-member-name">
          <Avatar user={member.user} size={32} />
          <div className="ss-member-text">
            <span className="ss-member-display">{displayName(member.user, member)}</span>
            <span className="ss-member-username">{member.user.username}</span>
          </div>
        </div>
      </td>
      <td>{formatDate(member.joined_at)}</td>
      <td>{formatDate(new Date(accountCreatedAt(member.user.id)).toISOString())}</td>
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
      <td>
        <div className="ss-chip-row">
          {signals.map(signal => (
            <span key={signal} className="ss-signal">
              {signal}
            </span>
          ))}
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

const SORTS: { value: string; label: string }[] = [
  { value: "joined:desc", label: "Member Since (Newest)" },
  { value: "joined:asc", label: "Member Since (Oldest)" },
  { value: "created:desc", label: "Account Age (Newest)" },
  { value: "created:asc", label: "Account Age (Oldest)" },
  { value: "name:asc", label: "Name (A-Z)" },
  { value: "name:desc", label: "Name (Z-A)" },
];

const PRUNE_DAYS = [1, 7, 30];

function PruneModal({ guild, onClose }: { guild: Guild; onClose(): void }) {
  const meId = useStore(s => s.me?.id) ?? "";
  const actorRoles = useStore(s => s.members[guild.id]?.[meId]?.roles) ?? [];
  const [days, setDays] = useState("7");
  const [include, setInclude] = useState<string[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actor = { id: meId, roles: actorRoles };
  const includable = guild.roles.filter(r => r.id !== guild.id && canEditRole(guild, actor, r)).sort((a, b) => b.position - a.position);

  useEffect(() => {
    let live = true;
    setCount(null);
    fetchPruneCount(guild.id, Number(days), include)
      .then(result => live && setCount(result.pruned ?? 0))
      .catch(e => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [guild.id, days, include]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await prune(guild.id, Number(days), include, reason);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Prune Members"
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={busy || !count} onClick={() => void submit()}>
            Prune
          </button>
        </>
      }
    >
      <div className="field-label">Last seen</div>
      <div className="mod-field">
        <Select label="Inactive for" value={days} options={PRUNE_DAYS.map(d => ({ value: String(d), label: d === 1 ? "1 day" : `${d} days` }))} onChange={setDays} />
      </div>
      <p className="modal-text" role="status">
        {count === null ? "Counting…" : `${count} ${count === 1 ? "member" : "members"} who joined over ${days} ${days === "1" ? "day" : "days"} ago and haven't posted since will be kicked.`}
      </p>
      {includable.length > 0 && (
        <>
          <div className="field-label">Include members with roles</div>
          <div className="ss-chip-row" role="group" aria-label="Include roles">
            {includable.map(r => (
              <button key={r.id} type="button" className={`ss-role-chip ss-chip-toggle${include.includes(r.id) ? " selected" : ""}`} aria-pressed={include.includes(r.id)} onClick={() => setInclude(list => (list.includes(r.id) ? list.filter(x => x !== r.id) : [...list, r.id]))}>
                <span className="ss-role-dot" style={{ background: roleColor(r) }} />
                {r.name}
              </button>
            ))}
          </div>
        </>
      )}
      <label className="field-label mod-reason-label" htmlFor="prune-reason">
        Reason
      </label>
      <textarea id="prune-reason" className="input mod-reason" value={reason} maxLength={512} placeholder="Optional" onChange={e => setReason(e.target.value)} />
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}

function BulkModal({ guild, action, ids, onClose }: { guild: Guild; action: "kick" | "ban"; ids: string[]; onClose(done: boolean): void }) {
  const [history, setHistory] = useState("0");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    const failed: string[] = [];
    for (const id of ids) {
      try {
        if (action === "kick") await request("DELETE", `/guilds/${guild.id}/members/${id}`, undefined, { reason });
        else await request("PUT", `/guilds/${guild.id}/bans/${id}`, { delete_message_seconds: Number(history), ...(reason.trim() ? { reason: reason.trim() } : {}) }, { reason });
      } catch (e) {
        failed.push(errorText(e));
      }
    }
    setBusy(false);
    if (failed.length === 0) onClose(true);
    else setError(`${failed.length} of ${ids.length} failed: ${failed[0] ?? ""}`);
  };
  const noun = `${ids.length} ${ids.length === 1 ? "member" : "members"}`;
  return (
    <Modal
      open
      onClose={() => onClose(false)}
      title={action === "kick" ? `Kick ${noun}` : `Ban ${noun}`}
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={() => onClose(false)}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void run()}>
            {action === "kick" ? "Kick" : "Ban"}
          </button>
        </>
      }
    >
      {action === "ban" && (
        <>
          <div className="field-label">Delete message history</div>
          <div className="mod-field">
            <Select label="Delete message history" value={history} options={BAN_HISTORY_OPTIONS} onChange={setHistory} />
          </div>
        </>
      )}
      <label className="field-label mod-reason-label" htmlFor="bulk-reason">
        Reason
      </label>
      <textarea id="bulk-reason" className="input mod-reason" value={reason} maxLength={512} placeholder="Optional" onChange={e => setReason(e.target.value)} />
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}

export function MembersPage({ guild, members }: { guild: Guild; members: Record<string, GuildMember> | undefined }) {
  const meId = useStore(s => s.me?.id) ?? "";
  const { can } = usePermissions(guild.id);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("joined:desc");
  const [roleFilter, setRoleFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<"kick" | "ban" | null>(null);
  const [pruning, setPruning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = useMemo(() => Object.values(members ?? {}), [members]);
  const actorMember = members?.[meId];
  const actor = { id: meId, roles: actorMember?.roles ?? [], communication_disabled_until: actorMember?.communication_disabled_until };

  const rows = useMemo(() => {
    const [key, direction] = sort.split(":") as [MemberSortKey, SortDirection];
    return sortMembers(filterMembers(all, query, roleFilter || null), key, direction);
  }, [all, query, sort, roleFilter]);

  // Only members the viewer may act on can be selected.
  const selectable = (m: GuildMember) => m.user.id !== meId && (canModerate(guild, actor, memberLike(m), "kick") || canModerate(guild, actor, memberLike(m), "ban"));
  const selectableRows = rows.filter(selectable);
  const picked = [...selected].filter(id => members?.[id]);
  const allPicked = selectableRows.length > 0 && selectableRows.every(m => selected.has(m.user.id));
  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const headerSort = (key: MemberSortKey) => setSort(current => (current === `${key}:desc` ? `${key}:asc` : `${key}:desc`));
  const ariaSort = (key: MemberSortKey) => (sort.startsWith(`${key}:`) ? (sort.endsWith("asc") ? "ascending" : "descending") : undefined);
  const roleOptions = [{ value: "", label: "All Roles" }, ...guild.roles.filter(r => r.id !== guild.id).sort((a, b) => b.position - a.position).map(r => ({ value: r.id, label: r.name }))];
  const canPrune = can(Perm.KICK_MEMBERS) && can(Perm.MANAGE_GUILD);
  const pickedKickable = picked.filter(id => members?.[id] && canModerate(guild, actor, memberLike(members[id]), "kick"));
  const pickedBannable = picked.filter(id => members?.[id] && canModerate(guild, actor, memberLike(members[id]), "ban"));

  return (
    <Page title="Members">
      <div className="ss-toolbar">
        <SearchBox value={query} onChange={setQuery} placeholder="Search by username or id" />
        <div className="ss-sort">
          <Select<string> label="Filter by role" value={roleFilter} onChange={setRoleFilter} options={roleOptions} />
        </div>
        <div className="ss-sort">
          <Select<string> label="Sort members" value={sort} onChange={setSort} options={SORTS} />
        </div>
        {canPrune && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPruning(true)}>
            Prune
          </button>
        )}
      </div>
      {error && <p className="field-error">{error}</p>}
      <div className="ss-count" aria-live="polite">
        {rows.length} {rows.length === 1 ? "Member" : "Members"}
        {picked.length > 0 && ` · ${picked.length} selected`}
      </div>
      {picked.length > 0 && (
        <div className="ss-bulk-bar" role="toolbar" aria-label="Selected members">
          <button type="button" className="btn btn-danger btn-sm" disabled={pickedKickable.length === 0} onClick={() => setBulk("kick")}>
            Kick {pickedKickable.length}
          </button>
          <button type="button" className="btn btn-danger btn-sm" disabled={pickedBannable.length === 0} onClick={() => setBulk("ban")}>
            Ban {pickedBannable.length}
          </button>
          <button type="button" className="btn btn-link btn-sm" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}
      <table className="ss-table ss-members-table">
        <thead>
          <tr>
            <th scope="col" className="ss-check-cell">
              <input
                type="checkbox"
                aria-label="Select all members"
                checked={allPicked}
                disabled={selectableRows.length === 0}
                onChange={() => setSelected(allPicked ? new Set() : new Set(selectableRows.map(m => m.user.id)))}
              />
            </th>
            <th scope="col" aria-sort={ariaSort("name")}>
              <button type="button" className="ss-th-sort" onClick={() => headerSort("name")}>
                Name
              </button>
            </th>
            <th scope="col" aria-sort={ariaSort("joined")}>
              <button type="button" className="ss-th-sort" onClick={() => headerSort("joined")}>
                Member Since
              </button>
            </th>
            <th scope="col" aria-sort={ariaSort("created")}>
              <button type="button" className="ss-th-sort" onClick={() => headerSort("created")}>
                Joined Vokko
              </button>
            </th>
            <th scope="col">Roles</th>
            <th scope="col">Signals</th>
            <th scope="col" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map(m => (
            <MemberRow key={m.user.id} guild={guild} member={m} onError={setError} selected={selected.has(m.user.id)} selectable={selectable(m)} onToggle={() => toggle(m.user.id)} />
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="settings-todo">No members match your search.</p>}
      {pruning && <PruneModal guild={guild} onClose={() => setPruning(false)} />}
      {bulk && (
        <BulkModal
          guild={guild}
          action={bulk}
          ids={bulk === "kick" ? pickedKickable : pickedBannable}
          onClose={done => {
            setBulk(null);
            if (done) setSelected(new Set());
          }}
        />
      )}
    </Page>
  );
}
