import { useCallback, useEffect, useRef, useState } from "react";
import { gateway } from "../../api/gateway";
import { request } from "../../api/rest";
import type { Guild, GuildJoinRequest, GuildJoinRequestList, JoinRequestStatus, MemberVerificationField } from "../../api/types";
import { Avatar } from "../Avatar";
import { Page } from "./controls";
import { errorText } from "./shared";

const TABS: { id: JoinRequestStatus; label: string; empty: string }[] = [
  { id: "SUBMITTED", label: "Submitted", empty: "No pending applications." },
  { id: "APPROVED", label: "Approved", empty: "No approved applications." },
  { id: "REJECTED", label: "Rejected", empty: "No rejected applications." },
];

const PAGE = 50;

function answerText(f: MemberVerificationField): string {
  if (f.field_type === "TERMS") return f.response === true ? "Agreed to the rules" : "Did not agree";
  if (f.field_type === "MULTIPLE_CHOICE") return typeof f.response === "number" ? (f.values?.[f.response] ?? "") : "No answer";
  return typeof f.response === "string" && f.response ? f.response : "No answer";
}

/** Server Settings > Join Requests: Apply to Join applications (GET/PATCH /guilds/{id}/requests), kept live by GUILD_JOIN_REQUEST_*. */
export function JoinRequestsPage({ guild }: { guild: Guild }) {
  const [tab, setTab] = useState<JoinRequestStatus>("SUBMITTED");
  const [rows, setRows] = useState<GuildJoinRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [total, setTotal] = useState(0);
  // Bumped by every first-page load: a response from an older load or page (other tab, or reset by an event) is dropped.
  const generation = useRef(0);

  // Always the first page: live events and decisions reset the list, "Load more" appends older pages.
  const load = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const list = await request<GuildJoinRequestList>("GET", `/guilds/${guild.id}/requests?status=${tab}&limit=${PAGE}`);
      if (gen !== generation.current) return;
      setRows(list.guild_join_requests);
      setTotal(list.total);
      setError(null);
    } catch (e) {
      if (gen !== generation.current) return;
      setError(errorText(e));
      setRows(current => current ?? []);
    }
  }, [guild.id, tab]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  useEffect(() => {
    const again = (e: { guild_id: string }) => e.guild_id === guild.id && void load();
    const offs = [gateway.on("GUILD_JOIN_REQUEST_CREATE", again), gateway.on("GUILD_JOIN_REQUEST_UPDATE", again), gateway.on("GUILD_JOIN_REQUEST_DELETE", again)];
    return () => offs.forEach(off => off());
  }, [guild.id, load]);

  const loadMore = async () => {
    const oldest = rows?.[rows.length - 1];
    if (!oldest) return;
    const gen = generation.current;
    setBusy(true);
    try {
      const list = await request<GuildJoinRequestList>("GET", `/guilds/${guild.id}/requests?status=${tab}&limit=${PAGE}&before=${oldest.id}`);
      if (gen !== generation.current) return;
      setRows(current => [...(current ?? []), ...list.guild_join_requests.filter(r => !current?.some(c => c.id === r.id))]);
      setTotal(list.total);
    } catch (e) {
      if (gen === generation.current) setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (row: GuildJoinRequest, action: "APPROVED" | "REJECTED") => {
    setBusy(true);
    setError(null);
    try {
      await request<GuildJoinRequest>("PATCH", `/guilds/${guild.id}/requests/${row.id}`, action === "REJECTED" && reason.trim() ? { action, rejection_reason: reason.trim() } : { action });
      setRejecting(null);
      setReason("");
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const current = TABS.find(t => t.id === tab)!;
  return (
    <Page title="Join Requests">
      <div className="ss-tabs" role="tablist" aria-label="Join request status">
        {TABS.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`ss-tab${tab === t.id ? " selected" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      {rows === null && <p className="settings-todo">Loading…</p>}
      {rows !== null && rows.length === 0 && <p className="settings-todo">{current.empty}</p>}
      {rows !== null && rows.length > 0 && (
        <ul className="ss-holder-list">
          {rows.map(row => {
            const expanded = open === row.id;
            const name = row.user.global_name ?? row.user.username;
            return (
              <li key={row.id} className="ss-holder jr-row" data-testid="join-request">
                <div className="jr-head">
                  <Avatar user={row.user} size={32} />
                  <div className="ss-member-text">
                    <span className="ss-member-display">{name}</span>
                    <span className="ss-member-username">Submitted {new Date(row.created_at).toLocaleString()}</span>
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : row.id)}>
                    {expanded ? "Hide answers" : "View answers"}
                  </button>
                  {tab === "SUBMITTED" && (
                    <>
                      <button type="button" className="btn btn-success btn-sm" disabled={busy} onClick={() => void decide(row, "APPROVED")}>
                        Approve
                      </button>
                      <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => { setRejecting(rejecting === row.id ? null : row.id); setReason(""); }}>
                        Reject
                      </button>
                    </>
                  )}
                </div>
                {tab === "REJECTED" && row.rejection_reason && <p className="ss-ban-reason">Reason: {row.rejection_reason}</p>}
                {expanded && (
                  <ul className="jr-answers">
                    {row.form_responses.length === 0 && <li className="jr-answer-label">This server has no questions.</li>}
                    {row.form_responses.map((f, i) => (
                      <li key={i}>
                        <div className="jr-answer-label">{f.label}</div>
                        <p className="jr-answer-text">{answerText(f)}</p>
                      </li>
                    ))}
                  </ul>
                )}
                {rejecting === row.id && (
                  <div className="jf-row">
                    <input className="input" aria-label="Rejection reason (optional)" placeholder="Reason (optional)" maxLength={160} value={reason} onChange={e => setReason(e.target.value)} />
                    <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void decide(row, "REJECTED")}>
                      Confirm reject
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {rows !== null && rows.length >= PAGE && rows.length < total && (
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void loadMore()}>
          Load more
        </button>
      )}
    </Page>
  );
}
