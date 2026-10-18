import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { acceptLogin, mfaLogin } from "../api/auth";
import { request } from "../api/rest";
import type { LoginResponse, MfaRequiredResponse } from "../api/types";
import { PasswordMeter } from "./PasswordMeter";
import { Field, Frame, SubmitButton, fieldErrors, tokenFromHash } from "./ui";

/** `/reset#token=...` from the reset mail: choose a new password, then signed in (or the two-factor step). */
export function ResetPage() {
  // read once, then drop the token from the address bar
  const [token] = useState(() => tokenFromHash(window.location.hash));
  useEffect(() => history.replaceState(null, "", window.location.pathname), []);
  const [password, setPassword] = useState("");
  const [ticket, setTicket] = useState<MfaRequiredResponse | null>(null);
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setErrors({});
    try {
      if (ticket) await mfaLogin(ticket.ticket, code);
      else {
        const step = acceptLogin(await request<LoginResponse>("POST", "/auth/reset", { token, password }));
        if (step) {
          setTicket(step);
          return;
        }
      }
      void navigate("/channels/@me", { replace: true });
    } catch (error) {
      setErrors(fieldErrors(error));
    } finally {
      setBusy(false);
    }
  }

  if (!token || errors.token) {
    return (
      <Frame title="This link has expired" subtitle={errors.token ?? "Ask for a new reset link from the login page."} footer={<Link to="/login">Back to login</Link>}>
        {null}
      </Frame>
    );
  }
  return (
    <Frame title={ticket ? "Multi-Factor Authentication" : "Change Your Password"} footer={<Link to="/login">Back to login</Link>}>
      <form className="auth-form" onSubmit={submit} noValidate>
        {ticket ? (
          <Field label="Authentication or backup code" required error={errors.code ?? errors.ticket ?? errors._}>
            <input className="input" value={code} onChange={e => setCode(e.target.value)} autoComplete="one-time-code" autoFocus />
          </Field>
        ) : (
          <Field label="New Password" required error={errors.password ?? errors._} hint={<PasswordMeter password={password} personal={[]} />}>
            <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
          </Field>
        )}
        <SubmitButton busy={busy}>{ticket ? "Log In" : "Change Password"}</SubmitButton>
      </form>
    </Frame>
  );
}
