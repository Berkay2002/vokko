import { useCallback, useEffect, useMemo, useState } from "react";
import { request } from "../../api/rest";
import type { Ban, Guild } from "../../api/types";
import { Modal } from "../../ui";
import { Avatar } from "../Avatar";
import { Page } from "./controls";
import { SearchBox, errorText } from "./shared";

export function BansPage({ guild }: { guild: Guild }) {
  const [bans, setBans] = useState<Ban[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<Ban | null>(null);
  const [busy, setBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBans(await request<Ban[]>("GET", `/guilds/${guild.id}/bans`));
      setError(null);
    } catch (e) {
      setError(errorText(e));
      setBans(current => current ?? []);
    }
  }, [guild.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = bans ?? [];
    if (!needle) return all;
    return all.filter(b => b.user.id === needle || b.user.username.toLowerCase().includes(needle) || (b.user.global_name ?? "").toLowerCase().includes(needle));
  }, [bans, query]);

  const revoke = async () => {
    if (!target) return;
    setBusy(true);
    setRevokeError(null);
    try {
      await request<void>("DELETE", `/guilds/${guild.id}/bans/${target.user.id}`);
      setTarget(null);
      await load();
    } catch (e) {
      setRevokeError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Bans">
      <p className="settings-todo">Banned users cannot rejoin the server through an invite link.</p>
      <div className="ss-toolbar">
        <SearchBox value={query} onChange={setQuery} placeholder="Search by username or id" />
      </div>
      {error && <p className="field-error">{error}</p>}
      {bans === null && <p className="settings-todo">Loading…</p>}
      {bans !== null && (
        <>
          <div className="ss-count" aria-live="polite">
            {rows.length} {rows.length === 1 ? "Ban" : "Bans"}
          </div>
          {bans.length === 0 ? (
            <p className="settings-todo">No bans</p>
          ) : rows.length === 0 ? (
            <p className="settings-todo">No bans match your search.</p>
          ) : (
            <ul className="ss-holder-list">
              {rows.map(b => (
                <li key={b.user.id} className="ss-member-name ss-holder">
                  <Avatar user={b.user} size={32} />
                  <div className="ss-member-text ss-ban-text">
                    <span className="ss-member-display">{b.user.global_name ?? b.user.username}</span>
                    <span className="ss-member-username">{b.user.username}</span>
                    <span className="ss-ban-reason">{b.reason ? `Reason: ${b.reason}` : "No reason provided"}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setRevokeError(null);
                      setTarget(b);
                    }}
                  >
                    Revoke Ban
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {target && (
        <Modal
          open
          onClose={() => setTarget(null)}
          title="Revoke Ban"
          footer={
            <>
              <button type="button" className="btn btn-link" onClick={() => setTarget(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void revoke()}>
                Revoke Ban
              </button>
            </>
          }
        >
          <p>Revoke the ban for {target.user.username}? They will be able to rejoin the server with an invite.</p>
          {revokeError && <p className="field-error">{revokeError}</p>}
        </Modal>
      )}
    </Page>
  );
}
