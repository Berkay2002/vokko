import { useCallback, useEffect, useState } from "react";
import { request } from "../../api/rest";
import { displayName, useStore } from "../../api/store";
import type { Guild, Report, ReportStatus, Snowflake } from "../../api/types";
import { Avatar } from "../Avatar";
import { REPORT_REASONS } from "../ReportModal";
import { Page, Select } from "./controls";
import { errorText } from "./shared";

const PAGE = 50;
const CONTENT_MAX = 300;

type Filter = ReportStatus | "all";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" },
  { value: "all", label: "All" },
];
const EMPTY: Record<Filter, string> = { open: "No open reports", resolved: "No resolved reports", dismissed: "No dismissed reports", all: "No reports" };

const reasonLabel = (reason: Report["reason"]) => REPORT_REASONS.find(r => r.value === reason)?.label ?? reason;

export function ReportsPage({ guild }: { guild: Guild }) {
  const channels = useStore(s => s.channels);
  const [reports, setReports] = useState<Report[] | null>(null);
  const [filter, setFilter] = useState<Filter>("open");
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<Snowflake | null>(null);
  const [updateError, setUpdateError] = useState<{ id: Snowflake; text: string } | null>(null);

  const load = useCallback(
    async (before?: Snowflake) => {
      setLoading(true);
      try {
        const query = new URLSearchParams({ status: filter, limit: String(PAGE) });
        if (before) query.set("before", before);
        const page = await request<Report[]>("GET", `/guilds/${guild.id}/reports?${query}`);
        setReports(prev => (before ? [...(prev ?? []), ...page] : page));
        setHasMore(page.length === PAGE);
        setError(null);
      } catch (e) {
        setError(errorText(e));
        setReports(prev => prev ?? []);
      } finally {
        setLoading(false);
      }
    },
    [guild.id, filter],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const update = async (report: Report, status: ReportStatus) => {
    setBusyId(report.id);
    setUpdateError(null);
    try {
      await request<Report>("PATCH", `/guilds/${guild.id}/reports/${report.id}`, { status });
      await load();
    } catch (e) {
      setUpdateError({ id: report.id, text: errorText(e) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Page title="Reports">
      <p className="settings-todo">Members can report messages and other members. Reports go to the moderators of this server.</p>
      <div className="ss-toolbar">
        <div className="ss-sort">
          <Select<Filter>
            label="Filter by status"
            value={filter}
            options={FILTERS}
            onChange={next => {
              setReports(null);
              setFilter(next);
            }}
          />
        </div>
      </div>
      {error && <p className="field-error">{error}</p>}
      {reports === null && <p className="settings-todo">Loading…</p>}
      {reports !== null && (
        <>
          <div className="ss-count" aria-live="polite">
            {reports.length} {reports.length === 1 ? "Report" : "Reports"}
          </div>
          {reports.length === 0 ? (
            <p className="settings-todo">{EMPTY[filter]}</p>
          ) : (
            <ul className="ss-holder-list">
              {reports.map(r => {
                const channel = r.channel_id ? channels[r.channel_id] : undefined;
                const content = r.message_content && r.message_content.length > CONTENT_MAX ? `${r.message_content.slice(0, CONTENT_MAX)}…` : r.message_content;
                return (
                  <li key={r.id} className="ss-member-name ss-holder">
                    <Avatar user={r.target_user} size={32} />
                    <div className="ss-member-text ss-ban-text">
                      <span className="ss-member-display">{displayName(r.target_user)}</span>
                      <span className="ss-member-username">{r.target_user.username}</span>
                      <span className="ss-ban-reason">
                        {reasonLabel(r.reason)} · Reported by {displayName(r.reporter)} · {new Date(r.created_at).toLocaleString()}
                      </span>
                      {r.details && <span className="ss-ban-reason">Details: {r.details}</span>}
                      {r.target_type === "message" && (
                        <span className="ss-ban-reason">
                          {channel?.name ? `#${channel.name}: ` : ""}
                          {content || "No text"}
                        </span>
                      )}
                      {updateError?.id === r.id && <span className="field-error">{updateError.text}</span>}
                    </div>
                    {r.status === "open" ? (
                      <>
                        <button type="button" className="btn btn-secondary btn-sm" disabled={busyId === r.id} onClick={() => void update(r, "resolved")}>
                          Resolve
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm" disabled={busyId === r.id} onClick={() => void update(r, "dismissed")}>
                          Dismiss
                        </button>
                      </>
                    ) : (
                      <button type="button" className="btn btn-secondary btn-sm" disabled={busyId === r.id} onClick={() => void update(r, "open")}>
                        Reopen
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {hasMore && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={loading} onClick={() => void load(reports.at(-1)?.id)}>
              Load more
            </button>
          )}
        </>
      )}
    </Page>
  );
}
