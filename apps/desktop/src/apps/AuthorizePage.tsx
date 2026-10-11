// `/oauth2/authorize?client_id=…&permissions=…`: the "Add to server" page of a bot (the invite URL from Developer settings).
import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { Check } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { PermBit, parseBits } from "../api/permissions";
import { useStore } from "../api/store";
import type { OAuth2AuthorizeInfo } from "../api/types";
import { authorize, authorizeInfo } from "./api";
import { AppIcon } from "./AppIcon";
import "./apps.css";

const label = (name: string) => name.toLowerCase().split("_").map(w => w[0]!.toUpperCase() + w.slice(1)).join(" ");

/** Readable names of the bits set in a permission bitfield. */
export function permissionNames(bits: string): string[] {
  const value = parseBits(bits);
  return Object.entries(PermBit)
    .filter(([, n]) => (value & (1n << BigInt(n))) !== 0n)
    .map(([name]) => label(name));
}

export function AuthorizePage() {
  const token = useStore(s => s.token);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const clientId = params.get("client_id") ?? "";
  const permissions = params.get("permissions") ?? undefined;
  const [info, setInfo] = useState<OAuth2AuthorizeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guildId, setGuildId] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token || !clientId) return;
    authorizeInfo(clientId, permissions).then(
      result => {
        setInfo(result);
        setGuildId(result.guilds[0]?.id ?? "");
      },
      e => setError(e instanceof ApiRequestError && e.status === 404 ? "This application does not exist or is private." : "Could not load the application."),
    );
  }, [token, clientId, permissions]);

  const names = useMemo(() => (info ? permissionNames(info.permissions) : []), [info]);
  if (!token) return <Navigate to="/login" replace />;

  const submit = async () => {
    if (!info || !guildId) return;
    setBusy(true);
    setError(null);
    try {
      await authorize(info.application.id, guildId, info.permissions);
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not add the app.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="apps-authorize-page">
      <div className="apps-authorize" role="dialog" aria-label="Add an app to a server">
        {!clientId && <p>The link has no application.</p>}
        {clientId && !info && !error && <p>Loading…</p>}
        {info && (
          <>
            <AppIcon name={info.application.name} icon={info.application.icon} size={80} />
            <p className="apps-authorize-eyebrow">An external application</p>
            <h1>{info.application.name}</h1>
            {info.application.description && <p className="apps-authorize-desc">{info.application.description}</p>}
            {done ? (
              <>
                <p className="apps-authorize-done">
                  <Check size={18} aria-hidden="true" /> Added to the server.
                </p>
                <button type="button" className="btn btn-wide" onClick={() => void navigate(`/channels/${guildId}`)}>
                  Go to the server
                </button>
              </>
            ) : (
              <>
                <label className="field-label" htmlFor="authorize-guild">
                  Add to server
                </label>
                {info.guilds.length === 0 ? (
                  <p className="apps-authorize-desc">You need the Manage Server permission in a server the bot is not in yet.</p>
                ) : (
                  <select id="authorize-guild" className="select" value={guildId} onChange={e => setGuildId(e.target.value)}>
                    {info.guilds.map(g => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                )}
                {names.length > 0 && (
                  <>
                    <div className="field-label">This will grant the bot</div>
                    <ul className="apps-authorize-perms">
                      {names.map(n => (
                        <li key={n}>
                          <Check size={14} aria-hidden="true" /> {n}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="apps-authorize-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => void navigate("/channels/@me")}>
                    Cancel
                  </button>
                  <button type="button" className="btn" disabled={busy || !guildId} onClick={() => void submit()}>
                    Authorize
                  </button>
                </div>
              </>
            )}
          </>
        )}
        {error && <p className="field-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
