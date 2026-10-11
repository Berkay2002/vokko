import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { gateway } from "../../api/gateway";
import { displayName, useStore } from "../../api/store";
import type { AuditLogEntry, AuditLogEvent, Guild, Snowflake, User } from "../../api/types";
import { Avatar } from "../Avatar";
import { Page, Select } from "./controls";
import { AUDIT_ACTIONS, auditDiff, describeAuditEntry, fetchAuditLog, type AuditLookup } from "./admin";
import { errorText } from "./shared";

const PAGE = 50;

function EntryRow({ entry, lookup }: { entry: AuditLogEntry; lookup: AuditLookup }) {
  const [open, setOpen] = useState(false);
  const diff = auditDiff(entry, lookup);
  const actor = entry.user_id ? lookup.users.get(entry.user_id) : undefined;
  const expandable = diff.length > 0 || !!entry.reason;
  const when = new Date(Number((BigInt(entry.id) >> 22n) + 1420070400000n));
  return (
    <li className={`ss-audit-entry${open ? " open" : ""}`} data-action={entry.action_type}>
      <button type="button" className="ss-audit-head" aria-expanded={expandable ? open : undefined} disabled={!expandable} onClick={() => setOpen(o => !o)}>
        {actor ? <Avatar user={actor} size={32} /> : <span className="ss-audit-dot" aria-hidden="true" />}
        <span className="ss-audit-text">
          <span className="ss-audit-summary">{describeAuditEntry(entry, lookup)}</span>
          <span className="ss-audit-time">{when.toLocaleString()}</span>
        </span>
        {expandable && (open ? <ChevronDown size={18} aria-hidden="true" /> : <ChevronRight size={18} aria-hidden="true" />)}
      </button>
      {open && (
        <div className="ss-audit-body">
          {diff.length > 0 && (
            <ul className="ss-audit-diff" aria-label="Changes">
              {diff.map((row, i) => (
                <li key={`${row.label}-${i}`}>
                  <span className="ss-audit-key">{row.label}</span>
                  {row.before !== null && (
                    <>
                      <span className="ss-audit-old">{row.before}</span>
                      <span aria-hidden="true">→</span>
                    </>
                  )}
                  <span className="ss-audit-new">{row.after ?? "removed"}</span>
                </li>
              ))}
            </ul>
          )}
          {entry.reason && <p className="ss-audit-reason">Reason: {entry.reason}</p>}
        </div>
      )}
    </li>
  );
}

export function AuditLogPage({ guild }: { guild: Guild }) {
  const members = useStore(s => s.members[guild.id]);
  const channels = useStore(s => s.channels);
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [users, setUsers] = useState<Map<Snowflake, User>>(new Map());
  const [userFilter, setUserFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (before?: Snowflake) => {
      setLoading(true);
      try {
        const log = await fetchAuditLog(guild.id, { user_id: userFilter || undefined, action_type: actionFilter ? (Number(actionFilter) as AuditLogEvent) : undefined, before, limit: PAGE });
        setUsers(prev => new Map([...prev, ...log.users.map(u => [u.id, u] as const)]));
        setEntries(prev => (before ? [...(prev ?? []), ...log.audit_log_entries] : log.audit_log_entries));
        setHasMore(log.audit_log_entries.length === PAGE);
        setError(null);
      } catch (e) {
        setError(errorText(e));
        setEntries(prev => prev ?? []);
      } finally {
        setLoading(false);
      }
    },
    [guild.id, userFilter, actionFilter],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // New entries arrive live (only members with View Audit Log receive them).
  useEffect(
    () =>
      gateway.on("GUILD_AUDIT_LOG_ENTRY_CREATE", entry => {
        if (entry.guild_id !== guild.id) return;
        if (userFilter && entry.user_id !== userFilter) return;
        if (actionFilter && entry.action_type !== Number(actionFilter)) return;
        setEntries(prev => (prev && !prev.some(e => e.id === entry.id) ? [entry, ...prev] : prev));
      }),
    [guild.id, userFilter, actionFilter],
  );

  const lookup: AuditLookup = useMemo(() => {
    const all = new Map(users);
    for (const m of Object.values(members ?? {})) if (!all.has(m.user.id)) all.set(m.user.id, m.user);
    return {
      users: all,
      roles: new Map(guild.roles.map(r => [r.id, r])),
      channels: new Map(Object.values(channels).filter(c => c.guild_id === guild.id).map(c => [c.id, c])),
    };
  }, [users, members, guild.roles, channels, guild.id]);

  const userOptions = useMemo(
    () => [{ value: "", label: "All Users" }, ...Object.values(members ?? {}).map(m => ({ value: m.user.id, label: displayName(m.user, m) })).sort((a, b) => a.label.localeCompare(b.label))],
    [members],
  );
  const actionOptions = [{ value: "", label: "All Actions" }, ...AUDIT_ACTIONS.map(a => ({ value: String(a.value), label: a.label }))];

  return (
    <Page title="Audit Log">
      <div className="ss-toolbar ss-audit-filters">
        <div className="ss-sort">
          <Select<string> label="Filter by user" value={userFilter} options={userOptions} onChange={setUserFilter} />
        </div>
        <div className="ss-sort">
          <Select<string> label="Filter by action" value={actionFilter} options={actionOptions} onChange={setActionFilter} />
        </div>
      </div>
      {error && <p className="field-error">{error}</p>}
      {entries === null ? (
        <p className="settings-todo">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="settings-todo">No logs yet. Actions taken by moderators show up here.</p>
      ) : (
        <ul className="ss-audit-list" aria-label="Audit log entries">
          {entries.map(entry => (
            <EntryRow key={entry.id} entry={entry} lookup={lookup} />
          ))}
        </ul>
      )}
      {hasMore && entries && (
        <button type="button" className="btn btn-secondary btn-sm" disabled={loading} onClick={() => void load(entries.at(-1)?.id)}>
          Load more
        </button>
      )}
    </Page>
  );
}
