import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, GripVertical, Lock, MoreHorizontal, Plus, X } from "lucide-react";
import { Perm, basePermissions, canEditRole, canModerate, hasBit, memberLike, parseBits } from "../../api/permissions";
import { appStore, displayName, useStore } from "../../api/store";
import { request } from "../../api/rest";
import type { Guild, GuildMember, Role, RolePositionUpdate, RoleRequest } from "../../api/types";
import { Modal, useContextMenu } from "../../ui";
import { getPrefs } from "../../ui/prefs";
import { Avatar } from "../Avatar";
import { Category, Divider, Field, Page, RadioGroup, SwitchRow } from "./controls";
import { useFrameLayout } from "./FullScreenSettings";
import { PERMISSION_GROUPS } from "./permissions";
import { SaveBar } from "./SaveBar";
import { blockedByUnsaved } from "./unsaved";
import { SearchBox, errorText, mergeMemberLocal, removeRoleLocal, roleColor, upsertRoles } from "./shared";
import { fetchRoleMemberCounts, nudgeRole } from "./admin";
import { gateway } from "../../api/gateway";

type RoleTab = "display" | "permissions" | "links" | "members";

/** Preset role colours (user data, not UI chrome). */
const COLOR_PRESETS = [0x1abc9c, 0x2ecc71, 0x3498db, 0x9b59b6, 0xe91e63, 0xf1c40f, 0xe67e22, 0xe74c3c, 0x95a5a6, 0x607d8b];

const HEX = /^#?([0-9a-fA-F]{6})$/;

/** Quick picks for the role icon (any emoji can be typed; role icons are free in Vokko). */
const ICON_PRESETS = ["⭐", "🛡️", "👑", "🎨", "🎮", "🔧", "💎", "🔥", "🌱", "🎵"];

interface Actor {
  id: string;
  roles: string[];
}

interface Draft {
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  permissions: bigint;
  icon: string;
}

const draftOf = (role: Role): Draft => ({ name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable, permissions: parseBits(role.permissions), icon: role.unicode_emoji ?? "" });

function MemberPicker({ guild, role, candidates, onPick, onClose }: { guild: Guild; role: Role; candidates: GuildMember[]; onPick(member: GuildMember): void; onClose(): void }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const list = needle ? candidates.filter(m => m.user.username.toLowerCase().includes(needle) || (m.user.global_name ?? "").toLowerCase().includes(needle) || (m.nick ?? "").toLowerCase().includes(needle)) : candidates;
  return (
    <Modal open onClose={onClose} title={`Add Members to ${role.name}`} footer={<button type="button" className="btn btn-secondary" onClick={onClose}>Done</button>}>
      <SearchBox value={query} onChange={setQuery} placeholder="Search members" />
      <ul className="ss-holder-list ss-picker-list" aria-label={`Add members to ${guild.name} role`}>
        {list.map(m => (
          <li key={m.user.id}>
            <button type="button" className="ss-picker-row" onClick={() => onPick(m)}>
              <Avatar user={m.user} size={32} />
              <span className="ss-member-text">
                <span className="ss-member-display">{displayName(m.user, m)}</span>
                <span className="ss-member-username">{m.user.username}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {list.length === 0 && <p className="settings-todo">No members to add.</p>}
    </Modal>
  );
}

function ConfirmDelete({ role, busy, error, onConfirm, onClose }: { role: Role; busy: boolean; error: string | null; onConfirm(): void; onClose(): void }) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Delete Role"
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={onConfirm}>
            Delete Role
          </button>
        </>
      }
    >
      <p>Are you sure you want to delete {role.name}? This cannot be undone.</p>
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}

function RoleEditor({ guild, role, members, actor, onBack }: { guild: Guild; role: Role; members: GuildMember[]; actor: Actor; onBack(): void }) {
  const [tab, setTab] = useState<RoleTab>("display");
  const [permQuery, setPermQuery] = useState("");
  const [draft, setDraft] = useState<Draft>(() => draftOf(role));
  const [hex, setHex] = useState(role.color === 0 ? "" : roleColor(role));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [picker, setPicker] = useState(false);
  const menu = useContextMenu();

  const isEveryone = role.id === guild.id;
  const editable = canEditRole(guild, actor, role);
  const viewerBits = basePermissions(guild, actor);
  const holders = isEveryone ? members : members.filter(m => m.roles.includes(role.id));
  const base = draftOf(role);
  const dirty =
    draft.name !== base.name || draft.color !== base.color || draft.hoist !== base.hoist || draft.mentionable !== base.mentionable || draft.permissions !== base.permissions || draft.icon.trim() !== base.icon;
  const isAdmin = hasBit(draft.permissions, Perm.ADMINISTRATOR);
  const needle = permQuery.trim().toLowerCase();
  const title = isEveryone ? "Edit Role - @everyone" : `Edit Role - ${role.name}`;
  const tabs: { id: RoleTab; label: string }[] = isEveryone
    ? [{ id: "permissions", label: "Permissions" }]
    : [
        { id: "display", label: "Display" },
        { id: "permissions", label: "Permissions" },
        { id: "links", label: "Links" },
        { id: "members", label: `Manage Members (${holders.length})` },
      ];
  const activeTab = isEveryone ? "permissions" : tab;

  const patch = (next: Partial<Draft>) => setDraft(d => ({ ...d, ...next }));
  const reset = () => {
    setDraft(draftOf(role));
    setHex(role.color === 0 ? "" : roleColor(role));
    setError(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const body: RoleRequest = isEveryone
      ? { permissions: draft.permissions.toString() }
      : {
          name: draft.name.trim() || role.name,
          color: draft.color,
          hoist: draft.hoist,
          permissions: draft.permissions.toString(),
          mentionable: draft.mentionable,
          unicode_emoji: draft.icon.trim() || null,
        };
    try {
      const updated = await request<Role>("PATCH", `/guilds/${guild.id}/roles/${role.id}`, body);
      upsertRoles(guild.id, [updated]);
      setDraft(draftOf(updated));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await request<void>("DELETE", `/guilds/${guild.id}/roles/${role.id}`);
      removeRoleLocal(guild.id, role.id);
      setConfirmDelete(false);
      onBack();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const setRoles = async (member: GuildMember, roles: string[]) => {
    setError(null);
    try {
      const updated = await request<GuildMember>("PATCH", `/guilds/${guild.id}/members/${member.user.id}`, { roles });
      mergeMemberLocal(guild.id, updated);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const canGive = (member: GuildMember) => editable && canModerate(guild, actor, memberLike(member), "roles");
  const candidates = members.filter(m => !m.roles.includes(role.id) && canGive(m));

  return (
    <div className="settings-page">
      <div className="ss-role-head">
        <h1 className="ss-role-title">{title}</h1>
        <button
          type="button"
          className="ss-icon-btn ss-role-more"
          aria-label="Role actions"
          aria-haspopup="menu"
          onClick={e =>
            menu.open(e, [
              ...(getPrefs().developerMode ? [{ id: "copy-id", label: "Copy Role ID", onSelect: () => void navigator.clipboard.writeText(role.id).catch(() => undefined) }, { type: "separator" as const }] : []),
              ...(editable && !isEveryone ? [{ id: "delete", label: "Delete Role", danger: true, onSelect: () => setConfirmDelete(true) }] : []),
            ])
          }
        >
          <MoreHorizontal size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="ss-tabs" role="tablist" aria-label="Role sections">
        {tabs.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={activeTab === t.id} className={`ss-tab${activeTab === t.id ? " selected" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {!editable && <p className="settings-todo">You can view this role but not change it.</p>}

      {activeTab === "display" && (
        <div role="tabpanel" aria-label="Display">
          <div className="settings-field">
            <div className="field-label">Role Name</div>
            <input className="input" value={draft.name} maxLength={100} disabled={!editable} aria-label="Role Name" onChange={e => patch({ name: e.target.value })} />
          </div>
          <Field label="Role Style">
            <RadioGroup<"solid"> name="Role style" value="solid" options={[{ value: "solid", label: "Solid", note: "A single colour for the role name." }]} onChange={() => undefined} />
          </Field>
          <div className="settings-field">
            <div className="field-label">Role Color</div>
            <div className="ss-color">
              <span className="ss-swatch" style={{ background: roleColor(draft) }} aria-hidden="true" />
              <input
                className="input ss-hex"
                aria-label="Role color hex"
                placeholder="#99aab5"
                value={hex}
                disabled={!editable}
                maxLength={7}
                onChange={e => {
                  setHex(e.target.value);
                  const m = HEX.exec(e.target.value.trim());
                  if (m) patch({ color: parseInt(m[1] ?? "0", 16) });
                  else if (e.target.value.trim() === "") patch({ color: 0 });
                }}
              />
            </div>
            <div className="ss-swatch-row" role="group" aria-label="Preset colors">
              <button
                type="button"
                className={`ss-swatch ss-swatch-button ss-swatch-default${draft.color === 0 ? " selected" : ""}`}
                aria-label="Default color"
                aria-pressed={draft.color === 0}
                disabled={!editable}
                onClick={() => {
                  patch({ color: 0 });
                  setHex("");
                }}
              />
              {COLOR_PRESETS.map(c => (
                <button
                  key={c}
                  type="button"
                  className={`ss-swatch ss-swatch-button${draft.color === c ? " selected" : ""}`}
                  style={{ background: roleColor({ color: c }) }}
                  aria-label={`Color ${roleColor({ color: c })}`}
                  aria-pressed={draft.color === c}
                  disabled={!editable}
                  onClick={() => {
                    patch({ color: c });
                    setHex(roleColor({ color: c }));
                  }}
                />
              ))}
            </div>
          </div>
          <div className="settings-field">
            <div className="field-label">Role Icon</div>
            <div className="ss-role-icon-row">
              <span className="ss-role-icon-preview" aria-hidden="true">
                {draft.icon || "—"}
              </span>
              <input className="input ss-hex" aria-label="Role icon emoji" placeholder="Emoji" maxLength={16} value={draft.icon} disabled={!editable} onChange={e => patch({ icon: e.target.value })} />
              <button type="button" className="btn btn-link btn-sm" disabled={!editable || !draft.icon} onClick={() => patch({ icon: "" })}>
                Remove Icon
              </button>
            </div>
            <div className="ss-swatch-row" role="group" aria-label="Preset role icons">
              {ICON_PRESETS.map(icon => (
                <button key={icon} type="button" className={`ss-icon-preset${draft.icon === icon ? " selected" : ""}`} aria-label={`Icon ${icon}`} aria-pressed={draft.icon === icon} disabled={!editable} onClick={() => patch({ icon })}>
                  {icon}
                </button>
              ))}
            </div>
          </div>
          <Divider />
          <SwitchRow label="Display role members separately from online members" checked={draft.hoist} onChange={v => patch({ hoist: v })} disabled={!editable} />
          <SwitchRow label="Allow anyone to @mention this role" checked={draft.mentionable} onChange={v => patch({ mentionable: v })} disabled={!editable} />
          {editable && (
            <>
              <Divider />
              <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
                Delete Role
              </button>
            </>
          )}
        </div>
      )}

      {activeTab === "permissions" && (
        <div role="tabpanel" aria-label="Permissions">
          <div className="ss-toolbar">
            <SearchBox value={permQuery} onChange={setPermQuery} placeholder="Search permissions" />
            <button type="button" className="btn btn-link btn-sm ss-clear-link" disabled={!editable || draft.permissions === 0n} onClick={() => patch({ permissions: 0n })}>
              Clear permissions
            </button>
          </div>
          {isAdmin && (
            <p className="ss-warning" role="alert">
              Administrator grants every permission and bypasses channel overrides. Only give it to roles you trust.
            </p>
          )}
          {PERMISSION_GROUPS.map(g => {
            const visible = g.permissions.filter(p => !needle || p.label.toLowerCase().includes(needle));
            if (visible.length === 0) return null;
            return (
              <Category key={g.title} title={g.title}>
                {visible.map(p => {
                  const bitValue = 1n << BigInt(p.bit);
                  const on = hasBit(draft.permissions, bitValue);
                  return (
                    <SwitchRow
                      key={p.bit}
                      label={p.label}
                      note={p.description}
                      checked={isAdmin || on}
                      onChange={() => patch({ permissions: draft.permissions ^ bitValue })}
                      disabled={!editable || !hasBit(viewerBits, bitValue)}
                    />
                  );
                })}
              </Category>
            );
          })}
        </div>
      )}

      {activeTab === "links" && (
        <div role="tabpanel" aria-label="Links">
          <p className="settings-todo">Role links are not available yet.</p>
        </div>
      )}

      {activeTab === "members" && (
        <div role="tabpanel" aria-label="Manage Members">
          <div className="ss-toolbar">
            <span className="ss-count">{holders.length} {holders.length === 1 ? "member" : "members"}</span>
            <button type="button" className="btn btn-primary btn-sm" disabled={!editable || candidates.length === 0} onClick={() => setPicker(true)}>
              Add Members
            </button>
          </div>
          {holders.length === 0 ? (
            <p className="settings-todo">No members have this role.</p>
          ) : (
            <ul className="ss-holder-list">
              {holders.map(m => (
                <li key={m.user.id} className="ss-member-name ss-holder">
                  <Avatar user={m.user} size={32} />
                  <div className="ss-member-text">
                    <span className="ss-member-display">{displayName(m.user, m)}</span>
                    <span className="ss-member-username">{m.user.username}</span>
                  </div>
                  <button type="button" className="ss-icon-btn" aria-label={`Remove ${m.user.username} from role`} disabled={!canGive(m)} onClick={() => void setRoles(m, m.roles.filter(r => r !== role.id))}>
                    <X size={16} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className="field-error">{error}</p>}

      <SaveBar visible={editable && dirty} busy={busy} error={null} onReset={reset} onSave={() => void save()} />

      {picker && (
        <MemberPicker
          guild={guild}
          role={role}
          candidates={candidates}
          onClose={() => setPicker(false)}
          onPick={m => {
            void setRoles(m, [...m.roles, role.id]);
          }}
        />
      )}
      {confirmDelete && <ConfirmDelete role={role} busy={busy} error={error} onConfirm={() => void remove()} onClose={() => setConfirmDelete(false)} />}
    </div>
  );
}

export function RolesPage({ guild, members }: { guild: Guild; members: Record<string, GuildMember> | undefined }) {
  const meId = useStore(s => s.me?.id) ?? "";
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [order, setOrder] = useState<Role[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const memberList = useMemo(() => Object.values(members ?? {}), [members]);
  const actor: Actor = { id: meId, roles: members?.[meId]?.roles ?? [] };
  const [serverCounts, setServerCounts] = useState<Record<string, number> | null>(null);
  // The member list in the store can be partial on big servers: the server's counts win when they arrive.
  useEffect(() => {
    let live = true;
    const refresh = () => void fetchRoleMemberCounts(guild.id).then(counts => live && setServerCounts(counts)).catch(() => undefined);
    refresh();
    const offs = [gateway.on("GUILD_MEMBER_UPDATE", m => m.guild_id === guild.id && refresh()), gateway.on("GUILD_MEMBER_REMOVE", m => m.guild_id === guild.id && refresh())];
    return () => {
      live = false;
      offs.forEach(off => off());
    };
  }, [guild.id]);
  const everyone = guild.roles.find(r => r.id === guild.id);
  const roles = useMemo(() => guild.roles.filter(r => r.id !== guild.id).sort((a, b) => b.position - a.position), [guild.roles, guild.id]);
  const active = selected ? guild.roles.find(r => r.id === selected) : undefined;

  useFrameLayout(active ? "roles" : "narrow");

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const role = await request<Role>("POST", `/guilds/${guild.id}/roles`, {} satisfies RoleRequest);
      upsertRoles(guild.id, [role]);
      setSelected(role.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setCreating(false);
    }
  };

  if (active) {
    const asideRoles = [...roles, ...(everyone ? [everyone] : [])];
    // A dirty RoleEditor would be dropped with the role, so the unsaved guard answers Back and a role switch with a shake instead.
    const leaveTo = (id: string | null) => {
      if (!blockedByUnsaved()) setSelected(id);
    };
    return (
      <div className="ss-roles-layout">
        <nav className="ss-roles-aside" aria-label="Roles">
          <div className="ss-aside-head">
            <button type="button" className="ss-aside-back" onClick={() => leaveTo(null)}>
              <ChevronLeft size={14} aria-hidden="true" /> Back
            </button>
            <button type="button" className="ss-icon-btn" aria-label="Create Role" disabled={creating} onClick={() => void create()}>
              <Plus size={16} aria-hidden="true" />
            </button>
          </div>
          {error && <p className="field-error">{error}</p>}
          {asideRoles.map(r => {
            const open = r.id === guild.id || canEditRole(guild, actor, r);
            return (
              <button key={r.id} type="button" className={`ss-aside-row${r.id === active.id ? " selected" : ""}`} aria-current={r.id === active.id ? "true" : undefined} disabled={!open} onClick={() => r.id !== active.id && leaveTo(r.id)}>
                <span className="ss-role-dot" style={{ background: roleColor(r) }} aria-hidden="true" />
                <span className="ss-aside-name">{r.id === guild.id ? "@everyone" : r.name}</span>
              </button>
            );
          })}
        </nav>
        <div className="ss-roles-editor">
          <RoleEditor key={active.id} guild={guild} role={active} members={memberList} actor={actor} onBack={() => setSelected(null)} />
        </div>
      </div>
    );
  }

  const shown = order ?? roles;
  const needle = query.trim().toLowerCase();
  const visible = needle ? shown.filter(r => r.name.toLowerCase().includes(needle)) : shown;
  const canReorder = !needle;
  const countOf = (role: Role) => serverCounts?.[role.id] ?? memberList.filter(m => m.roles.includes(role.id)).length;
  const editableRole = (role: Role) => canEditRole(guild, actor, role);

  const sendPositions = async (updates: RolePositionUpdate[]) => {
    if (updates.length === 0) return;
    setError(null);
    try {
      upsertRoles(guild.id, await request<Role[]>("PATCH", `/guilds/${guild.id}/roles`, updates));
    } catch (e) {
      setError(errorText(e));
    }
  };

  /** Alt+Up / Alt+Down moves a role one slot (keyboard alternative to dragging). */
  const nudge = (role: Role, direction: "up" | "down") => {
    const updates = nudgeRole(roles, role.id, direction);
    const other = updates[1] ? roles.find(r => r.id === updates[1]?.id) : undefined;
    if (!other || !editableRole(other)) return;
    void sendPositions(updates);
  };

  const drop = async (targetId: string) => {
    const from = dragId;
    setDragId(null);
    setOverId(null);
    if (!from || from === targetId || !canReorder) return;
    const fromIndex = roles.findIndex(r => r.id === from);
    const toIndex = roles.findIndex(r => r.id === targetId);
    const target = roles[toIndex];
    if (fromIndex < 0 || toIndex < 0 || !target || !editableRole(target)) return;
    const next = [...roles];
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) return;
    next.splice(toIndex, 0, moved);
    const positions = roles.map(r => r.position); // already descending: reuse the same slots
    const reordered = next.map((r, i) => ({ ...r, position: positions[i] ?? r.position }));
    const original = new Map(roles.map(r => [r.id, r.position]));
    const updates: RolePositionUpdate[] = reordered.filter(r => r.position !== original.get(r.id)).map(r => ({ id: r.id, position: r.position }));
    if (updates.length === 0) return;
    setOrder(reordered);
    setError(null);
    try {
      const result = await request<Role[]>("PATCH", `/guilds/${guild.id}/roles`, updates);
      upsertRoles(guild.id, Array.isArray(result) ? result : []);
      // Apply the positions locally as well so the list is right even if the response is partial.
      const state = appStore.getState();
      const current = state.guilds[guild.id];
      if (current) {
        const byId = new Map(updates.map(u => [u.id, u.position]));
        appStore.setState({ guilds: { ...state.guilds, [guild.id]: { ...current, roles: current.roles.map(r => (byId.has(r.id) ? { ...r, position: byId.get(r.id) ?? r.position } : r)) } } });
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setOrder(null);
    }
  };

  return (
    <Page title="Roles">
      <p className="settings-todo">Use roles to group your server members and assign permissions. Drag the handle (or press Alt+Up / Alt+Down) to reorder; higher roles rank above lower ones.</p>
      <div className="ss-toolbar">
        <SearchBox value={query} onChange={setQuery} placeholder="Search Roles" />
        <button type="button" className="btn btn-primary btn-sm" disabled={creating} onClick={() => void create()}>
          Create Role
        </button>
      </div>
      {error && <p className="field-error">{error}</p>}
      <div className="ss-count">Roles - {roles.length}</div>
      <div className="ss-role-list" role="list">
        {visible.map(role => {
          const editable = editableRole(role);
          const dragging = dragId === role.id;
          return (
            <div
              key={role.id}
              role="listitem"
              className={`ss-role-row ss-role-draggable${editable ? "" : " locked"}${dragging ? " dragging" : ""}${overId === role.id && dragId && dragId !== role.id ? " drop-target" : ""}`}
              draggable={editable && canReorder}
              aria-disabled={!editable}
              data-role-id={role.id}
              onDragStart={e => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", role.id);
                setDragId(role.id);
              }}
              onDragOver={e => {
                if (dragId && editable) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (overId !== role.id) setOverId(role.id);
                }
              }}
              onDrop={e => {
                e.preventDefault();
                void drop(role.id);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onClick={() => editable && setSelected(role.id)}
              onKeyDown={e => {
                if (editable && canReorder && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                  e.preventDefault();
                  nudge(role, e.key === "ArrowUp" ? "up" : "down");
                  return;
                }
                if (editable && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  setSelected(role.id);
                }
              }}
              tabIndex={editable ? 0 : -1}
            >
              <span className="ss-drag-handle" aria-hidden="true">
                {editable ? <GripVertical size={16} /> : <Lock size={14} />}
              </span>
              <span className="ss-role-dot" style={{ background: roleColor(role) }} aria-hidden="true" />
              {role.unicode_emoji && (
                <span className="ss-role-icon" aria-hidden="true">
                  {role.unicode_emoji}
                </span>
              )}
              <span className="ss-role-row-name">{role.name}</span>
              <span className="ss-role-row-count">
                {countOf(role)} {countOf(role) === 1 ? "member" : "members"}
              </span>
              {editable && <ChevronRight size={18} aria-hidden="true" />}
            </div>
          );
        })}
        {visible.length === 0 && <p className="settings-todo">No roles match your search.</p>}
        {everyone && (
          <div role="listitem">
          <button type="button" className="ss-role-row ss-role-default" onClick={() => setSelected(everyone.id)}>
            <div className="ss-role-row-text">
              <span className="ss-role-row-name">Default Permissions (@everyone)</span>
              <span className="ss-role-row-note">@everyone applies to all members of the server.</span>
            </div>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
          </div>
        )}
      </div>
    </Page>
  );
}
