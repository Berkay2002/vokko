import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { acceptLogin } from "../api/auth";
import { request } from "../api/rest";
import type { AuthResponse, InstanceInfo, MfaRequiredResponse, OAuthCompleteResponse, OAuthRegistration } from "../api/types";
import { fetchInstance } from "./api";
import { DateOfBirth, EMPTY_DATE, isoDate, type DateParts } from "./DateOfBirth";
import { MfaStep } from "./LoginPage";
import { completeOAuth } from "./oauth";
import { Field, Frame, fieldErrors } from "./ui";
import { UsernameHint, useUsernameCheck } from "./useUsernameCheck";

/** One redemption per result code, even when StrictMode runs the effect twice. */
const redeemed = new Map<string, Promise<OAuthCompleteResponse>>();

function redeem(code: string): Promise<OAuthCompleteResponse> {
  let pending = redeemed.get(code);
  if (!pending) redeemed.set(code, (pending = completeOAuth(code)));
  return pending;
}

/** First sign-in with a provider: pick a username, give a date of birth (and an email if the provider had none). */
function FinishSignUp({ registration }: { registration: OAuthRegistration }) {
  const [instance, setInstance] = useState<InstanceInfo | null>(null);
  const [username, setUsername] = useState(registration.suggested_username ?? "");
  const [email, setEmail] = useState("");
  const [dob, setDob] = useState<DateParts>(EMPTY_DATE);
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const status = useUsernameCheck(username);
  const navigate = useNavigate();
  useEffect(() => {
    fetchInstance().then(setInstance, () => setInstance(null));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const date = isoDate(dob);
    if (!date) return setErrors({ date_of_birth: "Required." });
    setBusy(true);
    setErrors({});
    try {
      const body = {
        ticket: registration.ticket,
        username,
        date_of_birth: date,
        ...(registration.global_name ? { global_name: registration.global_name } : {}),
        ...(registration.email ? {} : { email }),
        ...(instance?.terms ? { consent } : {}),
      };
      acceptLogin(await request<AuthResponse>("POST", "/auth/oauth/register", body));
      void navigate("/channels/@me", { replace: true });
    } catch (error) {
      setErrors(fieldErrors(error));
      setBusy(false);
    }
  }

  return (
    <Frame title="Finish creating your account" subtitle={registration.email ? `Signing up as ${registration.email}` : "Your provider didn't share a verified email, so add one."}>
      <form className="auth-form" onSubmit={submit} noValidate>
        {(errors.ticket || errors._) && <p className="auth-error" role="alert">{errors.ticket ?? errors._}</p>}
        {!registration.email && (
          <Field label="Email" required error={errors.email}>
            <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" autoFocus />
          </Field>
        )}
        {registration.email && errors.email && <p className="auth-error" role="alert">{errors.email}</p>}
        <Field label="Username" required error={errors.username} hint={<UsernameHint status={status} />}>
          <input className="input" value={username} maxLength={32} onChange={e => setUsername(e.target.value)} autoComplete="username" spellCheck={false} autoFocus={!!registration.email} />
        </Field>
        <div className="auth-field">
          <span className={`field-label${errors.date_of_birth ? " error" : ""}`} id="oauth-dob-label">
            Date of birth<span className="required"> *</span>
            {errors.date_of_birth && <span className="field-label-error"> - {errors.date_of_birth}</span>}
          </span>
          <div role="group" aria-labelledby="oauth-dob-label">
            <DateOfBirth value={dob} onChange={setDob} invalid={!!errors.date_of_birth} />
          </div>
        </div>
        {instance?.terms && (
          <label className={`auth-consent${errors.consent ? " error" : ""}`}>
            <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
            <span>{instance.terms}</span>
          </label>
        )}
        <button type="submit" className="btn btn-wide" disabled={busy}>
          Continue
        </button>
      </form>
    </Frame>
  );
}

type View =
  | { state: "busy" }
  | { state: "failed"; message: string }
  | { state: "mfa"; ticket: MfaRequiredResponse }
  | { state: "register"; registration: OAuthRegistration }
  | { state: "linked"; provider: string }
  | { state: "reauthenticated"; provider: string };

/** `/oauth/callback#code=…` (web redirect, or the desktop's vokko://auth/callback routed here). */
export function OAuthCallbackPage() {
  const [view, setView] = useState<View>({ state: "busy" });
  const navigate = useNavigate();
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const code = params.get("code");
    const error = params.get("error");
    if (error || !code) {
      setView({ state: "failed", message: error ?? "The sign-in did not finish. Try again." });
      return;
    }
    redeem(code).then(
      result => {
        if (result.kind === "login") {
          const step = acceptLogin(result.login);
          if (step) setView({ state: "mfa", ticket: step });
          else void navigate("/channels/@me", { replace: true });
        } else if (result.kind === "register") setView({ state: "register", registration: result.registration });
        else if (result.kind === "reauthenticated") setView({ state: "reauthenticated", provider: result.provider });
        else setView({ state: "linked", provider: result.provider });
      },
      failure => {
        const errors = fieldErrors(failure);
        setView({ state: "failed", message: errors.code ?? errors._ ?? Object.values(errors)[0] ?? "The sign-in failed." });
      },
    );
  }, [navigate]);

  switch (view.state) {
    case "busy":
      return <Frame title="Signing you in...">{null}</Frame>;
    case "mfa":
      return <MfaStep ticket={view.ticket} onBack={() => void navigate("/login", { replace: true })} />;
    case "register":
      return <FinishSignUp registration={view.registration} />;
    case "linked":
      return (
        <Frame title="Sign-in method linked" subtitle="You can now log in with it too." footer={<Link to="/channels/@me">Continue to Vokko</Link>}>
          {null}
        </Frame>
      );
    case "reauthenticated":
      return (
        <Frame title="Confirmed" subtitle="Thanks. Go back to My Account and finish your change within 5 minutes." footer={<Link to="/channels/@me">Continue to Vokko</Link>}>
          {null}
        </Frame>
      );
    default:
      return (
        <Frame title="Sign-in failed" subtitle={view.message} footer={<Link to="/login">Back to login</Link>}>
          {null}
        </Frame>
      );
  }
}
