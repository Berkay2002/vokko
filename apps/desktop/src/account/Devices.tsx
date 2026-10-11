// Logged-in devices: the user's sessions, with "log out" per device and for all other devices.

import { useEffect, useState } from "react";
import { Monitor, Smartphone } from "lucide-react";
import { request } from "../api/rest";
import type { UserSession } from "../api/types";

const MOBILE = new Set(["Android", "iOS"]);

function describe(session: UserSession): string {
  const { os, platform } = session.client_info;
  if (os && platform) return `${platform} on ${os}`;
  return platform ?? os ?? "Unknown device";
}

function lastUsed(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 10) return "Active recently";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function DevicesList() {
  const [sessions, setSessions] = useState<UserSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    request<{ user_sessions: UserSession[] }>("GET", "/auth/sessions").then(
      result => setSessions(result.user_sessions),
      () => setError("Couldn't load your devices."),
    );
  useEffect(() => {
    void load();
  }, []);
  const logOut = async (ids: string[]) => {
    await request<void>("POST", "/auth/sessions/logout", { session_id_hashes: ids });
    await load();
  };
  if (error) return <p className="field-error">{error}</p>;
  if (!sessions) return <p className="sm-muted">Loading devices...</p>;
  const others = sessions.filter(s => !s.current);
  return (
    <>
      <h3 className="sm-subhead">Devices</h3>
      <p className="acct-subtitle">Here are all the devices that are currently logged in with your Vokko account. Log out of any you don't recognise and change your password.</p>
      <ul className="acct-sessions" aria-label="Logged-in devices">
        {[...sessions.filter(s => s.current), ...others].map(session => {
          const Icon = MOBILE.has(session.client_info.os ?? "") ? Smartphone : Monitor;
          return (
            <li key={session.id_hash} className="acct-session">
              <Icon size={28} className="acct-session-icon" />
              <div className="acct-session-text">
                <div className="acct-session-name">{describe(session)}</div>
                <div className="acct-session-meta">{session.current ? "This device" : lastUsed(session.approx_last_used_time)}</div>
              </div>
              {!session.current && (
                <button type="button" className="sm-btn" aria-label={`Log out ${describe(session)}`} onClick={() => void logOut([session.id_hash])}>
                  Log Out
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {others.length > 0 && (
        <button type="button" className="sm-btn danger acct-logout-all" onClick={() => void logOut(others.map(s => s.id_hash))}>
          Log Out All Known Devices
        </button>
      )}
    </>
  );
}
