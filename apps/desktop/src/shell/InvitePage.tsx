import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { MailX, TriangleAlert } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { request, resolveUrl } from "../api/rest";
import { displayName, guildIconUrl, guildInitials, useStore } from "../api/store";
import type { Invite } from "../api/types";
import { ApplyToJoin } from "../invites/ApplyToJoin";
import { joinGuildWithInvite } from "./actions";
import { errorText, isApplyRequired, loadFailed, shownLoad, type InviteLoad } from "./inviteView";
import { guildPath } from "./nav";
import { pendingInvite } from "./pendingInvite";

/**
 * `/invite/:code`: Discord's "You've been invited to join" confirmation.
 * The preview carries the server's name, icon, online and member counts, the inviter and the invite's channel (no banner
 * or badge yet). The mock previews without an account; a server that answers 401 gets the generic "locked" card.
 */
export function InvitePage() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const token = useStore(s => s.token);
  const ready = useStore(s => s.ready);
  const memberOf = useStore(s => s.guilds);
  const [load, setLoad] = useState<InviteLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const closeApply = useCallback(() => setApplying(false), []);

  // A visitor who is not signed in keeps the code through login and register; the guest routes send them back here.
  useEffect(() => {
    if (token) pendingInvite.clear();
    else if (code) pendingInvite.set(code);
  }, [token, code]);

  useEffect(() => {
    let live = true;
    setLoad({ status: "loading" });
    setError(null);
    request<Invite>("GET", `/invites/${encodeURIComponent(code)}`).then(
      invite => live && setLoad({ status: "ok", invite }),
      failure => live && setLoad(loadFailed(failure)),
    );
    return () => {
      live = false;
    };
  }, [code, token, attempt]);

  const home = token ? "/channels/@me" : "/login";
  const shown = shownLoad(load, !!token, ready);
  const leave = (
    <Link className="btn btn-primary invite-button" to={home} onClick={() => pendingInvite.clear()}>
      Continue to Vokko
    </Link>
  );

  if (shown.status === "loading") {
    return (
      <div className="auth-page">
        <div className="auth-card invite-card" aria-busy="true">
          <div className="invite-skeleton" />
        </div>
      </div>
    );
  }

  if (shown.status === "locked") {
    return (
      <div className="auth-page">
        <div className="auth-card invite-card">
          <p className="invite-eyebrow">You've been invited to join a server</p>
          <h1 className="invite-name">Log in to continue</h1>
          <p className="invite-sub">Log in or register to see this invite and accept it.</p>
          <button type="button" className="btn btn-primary invite-button" onClick={() => void navigate("/login")}>
            Accept Invite
          </button>
          <Link className="invite-skip" to="/register">
            Create an account
          </Link>
        </div>
      </div>
    );
  }

  if (shown.status === "invalid") {
    return (
      <div className="auth-page">
        <div className="auth-card invite-card">
          <span className="invite-icon invite-icon-bad">
            <MailX size={32} aria-hidden />
          </span>
          <h1 className="invite-name">Invite Invalid</h1>
          <p className="invite-sub">This invite may be expired, or you might not have permission to join.</p>
          {leave}
        </div>
      </div>
    );
  }

  if (shown.status === "failed") {
    return (
      <div className="auth-page">
        <div className="auth-card invite-card">
          <span className="invite-icon invite-icon-bad">
            <TriangleAlert size={32} aria-hidden />
          </span>
          <h1 className="invite-name">Couldn't load this invite</h1>
          <p className="invite-sub" role="alert">
            {shown.message}
          </p>
          <button type="button" className="btn btn-primary invite-button" onClick={() => setAttempt(n => n + 1)}>
            Try again
          </button>
          <Link className="invite-skip" to={home}>
            Continue to Vokko
          </Link>
        </div>
      </div>
    );
  }

  const { guild, channel, inviter } = shown.invite;
  const icon = guildIconUrl(guild);
  const joined = !!memberOf[guild.id];

  const accept = async () => {
    if (!token) {
      void navigate("/login");
      return;
    }
    const target = guildPath(guild.id, channel.id);
    if (joined) {
      void navigate(target);
      return;
    }
    if (guild.join_mode === 1) {
      setApplying(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await joinGuildWithInvite(code);
      void navigate(target);
    } catch (failure) {
      // Revoked or used up since the preview: the card no longer applies.
      if (isApplyRequired(failure)) setApplying(true);
      else if (failure instanceof ApiRequestError && failure.status === 404) setLoad({ status: "invalid" });
      else setError(errorText(failure, "Could not join this server. Try again."));
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card invite-card" role="main" aria-label="Server invite">
        <p className="invite-eyebrow">
          {joined ? "You are already in" : inviter ? `${displayName(inviter)} invited you to join` : "You've been invited to join"}
        </p>
        <span className="invite-icon">{icon ? <img src={resolveUrl(icon)} alt="" draggable={false} /> : <span>{guildInitials(guild.name)}</span>}</span>
        <h1 className="invite-name">{guild.name}</h1>
        <p className="invite-counts">
          {guild.presence_count !== undefined && (
            <span className="invite-count">
              <i className="invite-dot online" /> {guild.presence_count.toLocaleString()} Online
            </span>
          )}
          <span className="invite-count">
            <i className="invite-dot" /> {guild.member_count.toLocaleString()} Member{guild.member_count === 1 ? "" : "s"}
          </span>
        </p>
        {error && (
          <p className="field-error invite-error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="btn btn-primary invite-button" disabled={busy} aria-busy={busy} onClick={() => void accept()}>
          {busy ? "Joining…" : joined ? "Continue to Server" : guild.join_mode === 1 ? "Apply to Join" : "Accept Invite"}
        </button>
        {applying && token && <ApplyToJoin code={code} onClose={closeApply} />}
        {token ? (
          <Link className="invite-skip" to={home} onClick={() => pendingInvite.clear()}>
            No thanks
          </Link>
        ) : (
          <>
            <p className="invite-sub">You will be asked to log in or register first.</p>
            <Link className="invite-skip" to="/register">
              Create an account
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
