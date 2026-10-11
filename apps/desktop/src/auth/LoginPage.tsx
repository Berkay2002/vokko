import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { login, mfaLogin } from "../api/auth";
import { MOCK } from "../api/config";
import { request } from "../api/rest";
import type { MfaRequiredResponse } from "../api/types";
import { Field, Frame, fieldErrors } from "./ui";
import { OAuthButtons } from "./OAuthButtons";

/** Discord's "Multi-Factor Authentication" step after a correct password. */
export function MfaStep({ ticket, onBack }: { ticket: MfaRequiredResponse; onBack(): void }) {
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setErrors({});
    try {
      await mfaLogin(ticket.ticket, code);
    } catch (error) {
      setErrors(fieldErrors(error));
      setBusy(false);
    }
  }

  return (
    <Frame
      title="Multi-Factor Authentication"
      subtitle={backup ? "Enter one of your 8-character backup codes." : "Enter the 6-digit code from your authenticator app."}
      footer={
        <button type="button" className="auth-link-inline" onClick={onBack}>
          Go back to login
        </button>
      }
    >
      <form className="auth-form" onSubmit={submit} noValidate>
        {errors.ticket && <p className="auth-error" role="alert">{errors.ticket}</p>}
        <Field label={backup ? "Backup code" : "Authentication code"} required error={errors.code ?? errors._}>
          <input
            className="input"
            value={code}
            onChange={e => setCode(e.target.value)}
            autoComplete="one-time-code"
            inputMode={backup ? "text" : "numeric"}
            maxLength={backup ? 9 : 6}
            placeholder={backup ? "xxxxxxxx" : "6-digit code"}
            autoFocus
            spellCheck={false}
          />
        </Field>
        {ticket.backup && (
          <button type="button" className="auth-link" onClick={() => { setBackup(b => !b); setCode(""); }}>
            {backup ? "Use your authenticator app" : "Use a backup code"}
          </button>
        )}
        <button type="submit" className="btn btn-wide" disabled={busy || !code.trim()}>
          Log In
        </button>
      </form>
      <OAuthButtons />
    </Frame>
  );
}

export function LoginPage() {
  const [name, setName] = useState(MOCK ? "sam" : "");
  const [password, setPassword] = useState(MOCK ? "vokko-dev" : "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState<MfaRequiredResponse | null>(null);
  const [resetSent, setResetSent] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setErrors({});
    try {
      const step = await login(name, password);
      if (step) setTicket(step);
    } catch (error) {
      const found = fieldErrors(error);
      if (found.login) found.password = found.login;
      setErrors(found);
    } finally {
      setBusy(false);
    }
  }

  async function forgot() {
    if (!name.trim()) {
      setErrors({ login: "Enter your email or username first." });
      return;
    }
    setErrors({});
    try {
      await request<void>("POST", "/auth/forgot", { login: name.trim() });
      setResetSent(true);
    } catch (error) {
      setErrors(fieldErrors(error));
    }
  }

  if (ticket) return <MfaStep ticket={ticket} onBack={() => { setTicket(null); setPassword(""); }} />;

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
        {resetSent && (
          <p className="auth-notice" role="status">
            If an account matches, we've sent password reset instructions to its email.
          </p>
        )}
        <Field label="Email or username" required error={errors.login ?? errors._}>
          <input className="input" value={name} onChange={e => setName(e.target.value)} autoComplete="username" autoFocus required />
        </Field>
        <Field label="Password" required error={errors.password}>
          <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        <button type="button" className="auth-link" onClick={() => void forgot()}>
          Forgot your password?
        </button>
        <button type="submit" className="btn btn-wide" disabled={busy}>
          Log In
        </button>
      </form>
      <OAuthButtons />
    </Frame>
  );
}
