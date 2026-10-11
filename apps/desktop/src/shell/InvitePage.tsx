import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { MailX } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { request } from "../api/rest";
import { guildIconUrl, guildInitials, useStore } from "../api/store";
import type { Snowflake } from "../api/types";
import { resolveUrl } from "../api/rest";
import { joinGuildWithInvite } from "./actions";
import { guildPath } from "./nav";
import { pendingInvite } from "./pendingInvite";

interface InviteInfo {
  code: string;
  guild: { id: Snowflake; name: string; icon: string | null };
  member_count?: number;
  approximate_member_count?: number;
  approximate_presence_count?: number;
}

/** `/invite/:code`: Discord's "You've been invited to join" confirmation, for logged-in and logged-out visitors. */
export function InvitePage() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const token = useStore(s => s.token);
  const ready = useStore(s => s.ready);
  const memberOf = useStore(s => s.guilds);
  const [info, setInfo] = useState<InviteInfo | null | undefined>(undefined);
  /** The server wants an account even to preview the invite: show the card without details. */
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A visitor who is not signed in keeps the code through login and register; the guest routes send them back here.
  useEffect(() => {
    if (token) pendingInvite.clear();
    else if (code) pendingInvite.set(code);
  }, [token, code]);

  useEffect(() => {
    let live = true;
    setInfo(undefined);
    setLocked(false);
    request<InviteInfo>("GET", `/invites/${encodeURIComponent(code)}`)
      .then(result => live && setInfo(result))
      .catch(e => {
        if (!live) return;
        if (e instanceof ApiRequestError && e.status === 401) setLocked(true);
        setInfo(null);
      });
    return () => {
      live = false;
    };
  }, [code]);

  const accept = async () => {
    if (!token) {
      void navigate("/login");
      return;
    }
    if (info && memberOf[info.guild.id]) {
      void navigate(guildPath(info.guild.id));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const guild = await joinGuildWithInvite(code);
      void navigate(guildPath(guild.id));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not join this server. Try again.");
      setBusy(false);
    }
  };

  const home = token ? "/channels/@me" : "/login";

  if (info === undefined) {
    return (
      <div className="auth-page">
        <div className="auth-card invite-card" aria-busy="true">
          <div className="invite-skeleton" />
        </div>
      </div>
    );
  }

  if (info === null && locked) {
    return (
      <div className="auth-page">
        <div className="auth-card invite-card">
          <p className="invite-eyebrow">You've been invited to join a server</p>
          <h1 className="invite-name">Log in to continue</h1>
          <p className="invite-sub">Log in or register to see this invite and accept it.</p>
          <button type="button" className="btn btn-primary invite-button" onClick={() => void navigate("/login")}>
            Accept Invite
          </button>
        </div>
      </div>
    );
  }

  if (info === null) {
    return (
      <div className="auth-page">
        <div className="auth-card invite-card">
          <span className="invite-icon invite-icon-bad">
            <MailX size={32} aria-hidden />
          </span>
          <h1 className="invite-name">Invite Invalid</h1>
          <p className="invite-sub">This invite may be expired, or you might not have permission to join.</p>
          <Link className="btn btn-primary invite-button" to={home}>
            Continue to Vokko
          </Link>
        </div>
      </div>
    );
  }

  const icon = guildIconUrl(info.guild);
  const members = info.approximate_member_count ?? info.member_count;
  const online = info.approximate_presence_count;
  const joined = !!memberOf[info.guild.id];

  return (
    <div className="auth-page">
      <div className="auth-card invite-card" role="main" aria-label="Server invite">
        <p className="invite-eyebrow">{joined ? "You are already in" : "You've been invited to join"}</p>
        <span className="invite-icon">{icon ? <img src={resolveUrl(icon)} alt="" draggable={false} /> : <span>{guildInitials(info.guild.name)}</span>}</span>
        <h1 className="invite-name">{info.guild.name}</h1>
        {(online !== undefined || members !== undefined) && (
          <p className="invite-counts">
            {online !== undefined && (
              <span className="invite-count">
                <i className="invite-dot invite-dot-online" /> {online} Online
              </span>
            )}
            {members !== undefined && (
              <span className="invite-count">
                <i className="invite-dot" /> {members} Member{members === 1 ? "" : "s"}
              </span>
            )}
          </p>
        )}
        {error && (
          <p className="field-error invite-error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="btn btn-primary invite-button" disabled={busy || (!!token && !ready)} onClick={() => void accept()}>
          {joined ? "Continue to Server" : "Accept Invite"}
        </button>
        {!token && <p className="invite-sub">You will be asked to log in or register first.</p>}
        <Link className="invite-skip" to={home}>
          No thanks
        </Link>
      </div>
    </div>
  );
}
