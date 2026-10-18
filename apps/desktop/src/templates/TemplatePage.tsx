import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { LayoutTemplate } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { useStore } from "../api/store";
import type { GuildTemplate } from "../api/types";
import { createGuildFromTemplate } from "../shell/actions";
import { errorText } from "../shell/settings/shared";
import { getTemplate } from "./api";
import { TemplatePreview } from "./TemplatePreview";
import "./templates.css";

type Load = { status: "loading" } | { status: "ok"; template: GuildTemplate } | { status: "invalid" } | { status: "failed"; message: string };

/** `/template/:code`: what the template makes and a form to create a server from it (Discord's template link page). */
export function TemplatePage() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const token = useStore(s => s.token);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let live = true;
    setLoad({ status: "loading" });
    getTemplate(code).then(
      template => {
        if (!live) return;
        setLoad({ status: "ok", template });
        setName(template.serialized_source_guild.name);
      },
      failure => live && setLoad(failure instanceof ApiRequestError && failure.status === 404 ? { status: "invalid" } : { status: "failed", message: errorText(failure) }),
    );
    return () => {
      live = false;
    };
  }, [code, token]);

  const home = token ? "/channels/@me" : "/login";

  if (!token) {
    return (
      <div className="auth-page">
        <div className="auth-card invite-card">
          <p className="invite-eyebrow">Server template</p>
          <h1 className="invite-name">Log in to continue</h1>
          <p className="invite-sub">Log in or register to create a server from this template.</p>
          <button type="button" className="btn btn-primary invite-button" onClick={() => void navigate("/login")}>
            Log In
          </button>
          <Link className="invite-skip" to="/register">
            Create an account
          </Link>
        </div>
      </div>
    );
  }

  if (load.status === "loading") {
    return (
      <div className="auth-page">
        <div className="auth-card invite-card" aria-busy="true">
          <div className="invite-skeleton" />
        </div>
      </div>
    );
  }

  if (load.status !== "ok") {
    return (
      <div className="auth-page">
        <div className="auth-card invite-card">
          <h1 className="invite-name">{load.status === "invalid" ? "Template Invalid" : "Couldn't load this template"}</h1>
          <p className="invite-sub" role={load.status === "failed" ? "alert" : undefined}>
            {load.status === "invalid" ? "This template may have been deleted, or the link is wrong." : load.message}
          </p>
          <Link className="btn btn-primary invite-button" to={home}>
            Continue to Vokko
          </Link>
        </div>
      </div>
    );
  }

  const { template } = load;
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await createGuildFromTemplate(code, name.trim());
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card tpl-card" role="main" aria-label="Server template">
        <div className="tpl-card-form">
          <span className="invite-icon">
            <LayoutTemplate size={32} aria-hidden="true" />
          </span>
          <p className="invite-eyebrow">Create a server from a template</p>
          <h1 className="invite-name">{template.name}</h1>
          {template.description && <p className="invite-sub">{template.description}</p>}
          <p className="tpl-meta">
            Used {template.usage_count.toLocaleString()} {template.usage_count === 1 ? "time" : "times"}
            {template.creator ? ` · by ${template.creator.global_name ?? template.creator.username}` : ""}
          </p>
          <label className="field-label" htmlFor="tpl-server-name">
            Server name <span className="required">*</span>
          </label>
          <input id="tpl-server-name" className="input" value={name} maxLength={100} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && name.trim().length >= 2 && !busy && void create()} />
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="btn btn-primary invite-button" disabled={busy || name.trim().length < 2} aria-busy={busy} onClick={() => void create()}>
            {busy ? "Creating…" : "Create Server"}
          </button>
          <Link className="invite-skip" to={home}>
            No thanks
          </Link>
        </div>
        <div className="tpl-card-preview">
          <div className="tpl-preview-title">{template.serialized_source_guild.name}</div>
          <TemplatePreview source={template.serialized_source_guild} />
        </div>
      </div>
    </div>
  );
}
