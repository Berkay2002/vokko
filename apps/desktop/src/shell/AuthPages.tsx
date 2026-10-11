import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { login, register } from "../api/auth";
import { ApiRequestError } from "../api/errors";
import { MOCK } from "../api/config";
import logo from "../../assets/icon.svg";

function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiRequestError)) return { _: error instanceof Error ? error.message : "Something went wrong." };
  const out: Record<string, string> = {};
  const errors = error.api.errors ?? {};
  for (const [field, value] of Object.entries(errors)) {
    const message = (value as { message?: string } | undefined)?.message;
    if (message) out[field] = message;
  }
  if (Object.keys(out).length === 0) out._ = error.status === 0 ? "Can't reach the server. Check your connection." : error.message;
  return out;
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <div className="auth-field">
      <label className={`field-label${error ? " error" : ""}`}>
        {label}
        {error && <span className="field-label-error"> - {error}</span>}
        {children}
      </label>
    </div>
  );
}

function Frame({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <img className="auth-logo" src={logo} alt="" width={48} height={48} />
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {children}
        <div className="auth-footer">{footer}</div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const [name, setName] = useState(MOCK ? "sam" : "");
  const [password, setPassword] = useState(MOCK ? "vokko-dev" : "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setErrors({});
    try {
      await login(name, password);
    } catch (error) {
      const found = fieldErrors(error);
      if (found.login) found.password = found.login;
      setErrors(found);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Frame
      title="Welcome back!"
      subtitle="We're so excited to see you again!"
      footer={
        <>
          Need an account? <Link to="/register">Register</Link>
        </>
      }
    >
      <form className="auth-form" onSubmit={submit} noValidate>
        <Field label="Email or username *" error={errors.login ?? errors._}>
          <input className="input" value={name} onChange={e => setName(e.target.value)} autoComplete="username" autoFocus required />
        </Field>
        <Field label="Password *" error={errors.password}>
          <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        <button type="submit" className="btn btn-wide" disabled={busy}>
          Log In
        </button>
      </form>
    </Frame>
  );
}

export function RegisterPage() {
  const [email, setEmail] = useState("");
  const [globalName, setGlobalName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setErrors({});
    try {
      await register({ email, username, password, global_name: globalName || undefined });
    } catch (error) {
      setErrors(fieldErrors(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Frame
      title="Create an account"
      footer={
        <>
          <Link to="/login">Already have an account?</Link>
        </>
      }
    >
      <form className="auth-form" onSubmit={submit} noValidate>
        <Field label="Email *" error={errors.email}>
          <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" autoFocus required />
        </Field>
        <Field label="Display name" error={errors.global_name}>
          <input className="input" value={globalName} onChange={e => setGlobalName(e.target.value)} autoComplete="nickname" />
        </Field>
        <Field label="Username *" error={errors.username ?? errors._}>
          <input className="input" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required />
        </Field>
        <Field label="Password *" error={errors.password}>
          <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" required />
        </Field>
        <button type="submit" className="btn btn-wide" disabled={busy}>
          Continue
        </button>
      </form>
    </Frame>
  );
}
