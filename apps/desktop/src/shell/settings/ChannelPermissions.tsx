import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Lock, Minus, Plus, Search, X } from "lucide-react";
import { ApiRequestError } from "../../api/errors";
import { Perm, TEXT_OVERWRITE_BITS, VOICE_OVERWRITE_BITS, bit, hasBit, parseBits } from "../../api/permissions";
import { request } from "../../api/rest";
import { appStore, displayName, useStore } from "../../api/store";
import { ChannelType, OverwriteType, type Channel, type Guild, type GuildMember, type PermissionOverwrite, type Role } from "../../api/types";
import { Avatar } from "../Avatar";
import { usePermissions } from "../usePermissions";
import { Category, Page, SwitchRow, Unavailable } from "./controls";
import { PERMISSION_GROUPS } from "./permissions";
import { SaveBar } from "./SaveBar";
import { roleColor } from "./server-people";

interface Draft {
  type: OverwriteType;
  allow: bigint;
  deny: bigint;
}
type Drafts = Record<string, Draft>;

type Tri = "deny" | "neutral" | "allow";

/** Channel-context names for bits whose server-wide label reads differently. */
const LABEL_OVERRIDES: Record<number, string> = { 4: "Manage Channel", 28: "Manage Permissions", 10: "View Channel" };

function toDrafts(overwrites: PermissionOverwrite[] | undefined): Drafts {
  const out: Drafts = {};
  for (const o of overwrites ?? []) out[o.id] = { type: o.type, allow: parseBits(o.allow), deny: parseBits(o.deny) };
  return out;
}

function sameDraft(a: Draft | undefined, b: Draft | undefined): boolean {
  return !!a && !!b && a.type === b.type && a.allow === b.allow && a.deny === b.deny;
}

const isEmpty = (d: Draft | undefined): boolean => !d || (d.allow === 0n && d.deny === 0n);

function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "Something went wrong. Try again.";
}

function bitsFor(type: ChannelType): number[] {
  if (type === ChannelType.GuildVoice) return [...VOICE_OVERWRITE_BITS];
  if (type === ChannelType.GuildCategory) return [...new Set([...TEXT_OVERWRITE_BITS, ...VOICE_OVERWRITE_BITS])];
  return [...TEXT_OVERWRITE_BITS];
}

function overwriteKeys(list: PermissionOverwrite[] | undefined): string[] {
  return (list ?? []).map(o => `${o.id}:${o.type}:${o.allow}:${o.deny}`).sort();
}

function sameOverwrites(a: PermissionOverwrite[] | undefined, b: PermissionOverwrite[] | undefined): boolean {
  const x = overwriteKeys(a);
  const y = overwriteKeys(b);
  return x.length === y.length && x.every((k, i) => k === y[i]);
}

function TriState({ value, disabled, label, onChange }: { value: Tri; disabled: boolean; label: string; onChange(next: Tri): void }) {
  const button = (next: Tri, icon: ReactNode, title: string) => (
    <button key={next} type="button" role="radio" aria-checked={value === next} aria-label={`${title} ${label}`} title={title} disabled={disabled} className={`cs-tri-btn ${next}${value === next ? " on" : ""}`} onClick={() => onChange(next)}>
      {icon}
    </button>
  );
  return (
    <div className="cs-tri" role="radiogroup" aria-label={label}>
      {button("deny", <X size={16} />, "Deny")}
      {button("neutral", <Minus size={16} />, "Inherit")}
      {button("allow", <Check size={16} />, "Allow")}
    </div>
  );
}

interface Target {
  id: string;
  type: OverwriteType;
  label: string;
  color?: string;
  member?: GuildMember;
}

function TargetRow({ target, selected, onSelect }: { target: Target; selected: boolean; onSelect(): void }) {
  return (
    <button type="button" className={`cs-target${selected ? " selected" : ""}`} aria-current={selected ? "true" : undefined} onClick={onSelect}>
      {target.member ? <Avatar user={target.member.user} size={20} /> : <span className="cs-dot" style={{ background: target.color ?? "var(--text-muted)" }} />}
      <span className="cs-target-name">{target.label}</span>
    </button>
  );
}

export function ChannelPermissionsPage({ channel, guild, members }: { channel: Channel; guild: Guild; members: Record<string, GuildMember> | undefined }) {
  const { bits: viewerBits, can, isOwner } = usePermissions(guild.id, channel.id);
  const editable = can(Perm.MANAGE_ROLES);
  const original = useMemo(() => toDrafts(channel.permission_overwrites), [channel.permission_overwrites]);
  const [drafts, setDrafts] = useState<Drafts>(original);
  const [selected, setSelected] = useState<string>(guild.id);
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setDrafts(original), [original]);
  const category = useStore(s => (channel.parent_id ? s.channels[channel.parent_id] : undefined));
  const [syncing, setSyncing] = useState(false);

  const roleById = useMemo(() => new Map<string, Role>(guild.roles.map(r => [r.id, r])), [guild.roles]);

  const targetFor = (id: string, type: OverwriteType): Target => {
    if (type === OverwriteType.Role) {
      const role = roleById.get(id);
      return { id, type, label: id === guild.id ? "@everyone" : (role?.name ?? "Unknown role"), color: role && role.color !== 0 ? roleColor(role) : undefined };
    }
    const member = members?.[id];
    return { id, type, label: member ? displayName(member.user, member) : "Unknown member", member };
  };

  const targets = useMemo(() => {
    const list: Target[] = [];
    if (!drafts[guild.id]) list.push(targetFor(guild.id, OverwriteType.Role));
    const rank = (id: string, type: OverwriteType) => (id === guild.id ? -1 : type === OverwriteType.Role ? 1000 - (roleById.get(id)?.position ?? 0) : 100000);
    for (const [id, d] of Object.entries(drafts).sort((a, b) => rank(a[0], a[1].type) - rank(b[0], b[1].type))) list.push(targetFor(id, d.type));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, roleById, members, guild.id]);

  const current = drafts[selected] ?? { type: OverwriteType.Role, allow: 0n, deny: 0n };

  const dirty = useMemo(() => {
    for (const id of new Set([...Object.keys(original), ...Object.keys(drafts)])) {
      const a = original[id];
      const b = drafts[id];
      if (!a && isEmpty(b)) continue;
      if (isEmpty(b) ? !!a : !sameDraft(a, b)) return true;
    }
    return false;
  }, [original, drafts]);

  const grantable = (n: number) => isOwner || hasBit(viewerBits, bit(n));

  const setDraft = (id: string, type: OverwriteType, change: (d: Draft) => Draft) => {
    setSaved(false);
    setDrafts(prev => ({ ...prev, [id]: change(prev[id] ?? { type, allow: 0n, deny: 0n }) }));
  };

  const setBit = (n: number, next: Tri) => {
    const mask = bit(n);
    setDraft(selected, current.type, d => ({ ...d, allow: next === "allow" ? d.allow | mask : d.allow & ~mask, deny: next === "deny" ? d.deny | mask : d.deny & ~mask }));
  };

  const privateOn = hasBit(drafts[guild.id]?.deny ?? 0n, Perm.VIEW_CHANNEL);
  const setPrivate = (on: boolean) => {
    const mask = Perm.VIEW_CHANNEL;
    setDraft(guild.id, OverwriteType.Role, d => ({ ...d, allow: on ? d.allow & ~mask : d.allow, deny: on ? d.deny | mask : d.deny & ~mask }));
  };

  const remove = () => {
    setSaved(false);
    setDrafts(prev => {
      const { [selected]: _gone, ...rest } = prev;
      return rest;
    });
    setSelected(guild.id);
  };

  const reset = () => {
    setDrafts(original);
    setSelected(guild.id);
    setError(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const next: Drafts = { ...original };
    try {
      for (const id of new Set([...Object.keys(original), ...Object.keys(drafts)])) {
        const a = original[id];
        const b = drafts[id];
        if (isEmpty(b)) {
          if (a) {
            await request<void>("DELETE", `/channels/${channel.id}/permissions/${id}`);
            delete next[id];
          }
        } else if (!sameDraft(a, b)) {
          await request<void>("PUT", `/channels/${channel.id}/permissions/${id}`, { type: b.type, allow: b.allow.toString(), deny: b.deny.toString() });
          next[id] = b;
        }
      }
      setSaved(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      const overwrites: PermissionOverwrite[] = Object.entries(next).map(([id, d]) => ({ id, type: d.type, allow: d.allow.toString(), deny: d.deny.toString() }));
      const state = appStore.getState();
      state.upsertChannel({ ...(state.channels[channel.id] ?? channel), permission_overwrites: overwrites });
      setBusy(false);
    }
  };

  const syncNow = async () => {
    if (!channel.parent_id) return;
    setSyncing(true);
    setError(null);
    try {
      const updated = await request<Channel>("PATCH", `/channels/${channel.id}`, { parent_id: channel.parent_id, lock_permissions: true });
      const state = appStore.getState();
      state.upsertChannel({ ...(state.channels[channel.id] ?? channel), ...updated });
      setSaved(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSyncing(false);
    }
  };

  const available = useMemo(() => {
    const q = query.trim().toLowerCase();
    const roles = guild.roles.filter(r => r.id !== guild.id && !drafts[r.id] && r.name.toLowerCase().includes(q)).sort((a, b) => b.position - a.position);
    const people = Object.values(members ?? {})
      .filter(m => !drafts[m.user.id] && (displayName(m.user, m).toLowerCase().includes(q) || m.user.username.toLowerCase().includes(q)))
      .slice(0, 50);
    return { roles, people };
  }, [guild.roles, guild.id, members, drafts, query]);

  const add = (id: string, type: OverwriteType) => {
    setDraft(id, type, d => d);
    setSelected(id);
    setPicker(false);
    setQuery("");
  };

  const allowed = new Set(bitsFor(channel.type));
  const groups = PERMISSION_GROUPS.map(g => ({ title: g.title, permissions: g.permissions.filter(p => allowed.has(p.bit)) })).filter(g => g.permissions.length > 0);
  const selectedTarget = targetFor(selected, current.type);
  const triOf = (n: number): Tri => (hasBit(current.allow, bit(n)) ? "allow" : hasBit(current.deny, bit(n)) ? "deny" : "neutral");
  const noun = channel.type === ChannelType.GuildCategory ? "category" : "channel";

  return (
    <Page title="Permissions">
      {!editable && <Unavailable>You need the Manage Permissions permission to change this {noun}'s permissions.</Unavailable>}
      {category && channel.type !== ChannelType.GuildCategory && (
        <div className="cs-sync" role="status">
          {sameOverwrites(channel.permission_overwrites, category.permission_overwrites) ? (
            <span className="cs-sync-text">Synced with category: {category.name ?? "Unnamed category"}</span>
          ) : (
            <>
              <span className="cs-sync-text">Not synced with category</span>
              {editable && (
                <button type="button" className="btn btn-primary btn-sm" disabled={syncing || busy || dirty} onClick={() => void syncNow()}>
                  {syncing ? "Syncing…" : "Sync Now"}
                </button>
              )}
            </>
          )}
        </div>
      )}
      <SwitchRow label="Private Channel" note={`By making a ${noun} private, only select members and roles will be able to view it.`} checked={privateOn} disabled={!editable || !grantable(10)} onChange={setPrivate} />
      <Category title="Advanced Permissions">
        <div className="cs-perm-editor">
          <div className="cs-targets">
            <div className="cs-targets-head">
              <span>Roles / Members</span>
              {editable && (
                <button type="button" className="cs-icon-btn" aria-label="Add role or member" aria-expanded={picker} onClick={() => setPicker(p => !p)}>
                  <Plus size={16} />
                </button>
              )}
            </div>
            {picker && (
              <div className="cs-picker">
                <div className="ss-search">
                  <Search size={14} aria-hidden="true" />
                  <input className="ss-search-input" autoFocus placeholder="Search roles and members" aria-label="Search roles and members" value={query} onChange={e => setQuery(e.target.value)} />
                </div>
                <div className="cs-picker-list">
                  {available.roles.length > 0 && <div className="cs-picker-title">Roles</div>}
                  {available.roles.map(r => (
                    <button key={r.id} type="button" className="cs-target" onClick={() => add(r.id, OverwriteType.Role)}>
                      <span className="cs-dot" style={{ background: roleColor(r) }} />
                      <span className="cs-target-name">{r.name}</span>
                    </button>
                  ))}
                  {available.people.length > 0 && <div className="cs-picker-title">Members</div>}
                  {available.people.map(m => (
                    <button key={m.user.id} type="button" className="cs-target" onClick={() => add(m.user.id, OverwriteType.Member)}>
                      <Avatar user={m.user} size={20} />
                      <span className="cs-target-name">{displayName(m.user, m)}</span>
                    </button>
                  ))}
                  {available.roles.length === 0 && available.people.length === 0 && <p className="settings-todo">Nothing to add.</p>}
                </div>
              </div>
            )}
            {targets.map(t => (
              <TargetRow key={t.id} target={t} selected={t.id === selected} onSelect={() => setSelected(t.id)} />
            ))}
          </div>
          <div className="cs-perms">
            <div className="cs-perms-head">
              <span className="cs-perms-title">{selectedTarget.label}</span>
              {editable && (
                <span className="cs-perms-actions">
                  <button type="button" className="btn btn-link btn-sm" disabled={current.allow === 0n && current.deny === 0n} onClick={() => setDraft(selected, current.type, d => ({ ...d, allow: 0n, deny: 0n }))}>
                    Clear permissions
                  </button>
                  <button type="button" className="btn btn-link btn-sm cs-danger" disabled={selected === guild.id || !drafts[selected]} onClick={remove}>
                    Remove overwrite
                  </button>
                </span>
              )}
            </div>
            {groups.map(g => (
              <section key={g.title} className="cs-perm-group">
                <h3 className="cs-perm-group-title">{g.title}</h3>
                {g.permissions.map(p => {
                  const label = LABEL_OVERRIDES[p.bit] ?? p.label;
                  return (
                    <div key={p.bit} className="cs-perm-row">
                      <span className="cs-perm-label">
                        {p.bit === 10 && privateOn && selected === guild.id && <Lock size={12} aria-hidden="true" />} {label}
                      </span>
                      <TriState value={triOf(p.bit)} label={label} disabled={!editable || !grantable(p.bit)} onChange={next => setBit(p.bit, next)} />
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
        </div>
      </Category>
      {saved && !dirty && <p className="settings-saved">Saved.</p>}
      <SaveBar visible={dirty || !!error} busy={busy} error={error} onReset={reset} onSave={() => void save()} />
    </Page>
  );
}
