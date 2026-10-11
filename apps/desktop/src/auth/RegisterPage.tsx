import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { register } from "../api/auth";
import type { InstanceInfo } from "../api/types";
import { fetchInstance } from "./api";
import { DateOfBirth, EMPTY_DATE, isoDate, type DateParts } from "./DateOfBirth";
import { PasswordMeter } from "./PasswordMeter";
import { Field, Frame, fieldErrors } from "./ui";
import { UsernameHint, useUsernameCheck } from "./useUsernameCheck";
import { OAuthButtons } from "./OAuthButtons";

export function RegisterPage() {
  const [instance, setInstance] = useState<InstanceInfo | null>(null);
  const [email, setEmail] = useState("");
  const [globalName, setGlobalName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [dob, setDob] = useState<DateParts>(EMPTY_DATE);
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const usernameStatus = useUsernameCheck(username);

  useEffect(() => {
    fetchInstance().then(setInstance, () => setInstance(null));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const date = isoDate(dob);
    if (!date) {
      setErrors({ date_of_birth: "Required." });
      return;
    }
    if (instance?.terms && !consent) {
      setErrors({ consent: "You need to agree to the terms." });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await register({ email, username, password, global_name: globalName.trim() || undefined, date_of_birth: date, ...(instance?.terms ? { consent } : {}) });
    } catch (error) {
      setErrors(fieldErrors(error));
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <>
      <Link to="/login">Already have an account?</Link>
    </>
  );

  if (instance?.registration === "closed") {
    return (
      <Frame title="Registration is closed" subtitle="This Vokko server doesn't accept new accounts right now. Ask its owner for access." footer={footer}>
        {null}
      </Frame>
    );
  }

  return (
    <Frame title="Create an account" footer={footer}>
      <form className="auth-form" onSubmit={submit} noValidate>
        {errors._ && <p className="auth-error" role="alert">{errors._}</p>}
        <Field label="Email" required error={errors.email}>
          <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" autoFocus required />
        </Field>
        <Field label="Display name" error={errors.global_name} hint={<p className="auth-hint">This is how others see you. You can use special characters and emoji.</p>}>
          <input className="input" value={globalName} maxLength={32} onChange={e => setGlobalName(e.target.value)} autoComplete="nickname" />
        </Field>
        <Field label="Username" required error={errors.username} hint={<UsernameHint status={usernameStatus} />}>
          <input className="input" value={username} maxLength={32} onChange={e => setUsername(e.target.value)} autoComplete="username" required spellCheck={false} />
        </Field>
        <Field label="Password" required error={errors.password} hint={<PasswordMeter password={password} personal={[username, email]} />}>
          <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" required />
        </Field>
        <div className="auth-field">
          <span className={`field-label${errors.date_of_birth ? " error" : ""}`} id="dob-label">
            Date of birth<span className="required"> *</span>
            {errors.date_of_birth && <span className="field-label-error"> - {errors.date_of_birth}</span>}
          </span>
          <div role="group" aria-labelledby="dob-label">
            <DateOfBirth value={dob} onChange={setDob} invalid={!!errors.date_of_birth} />
          </div>
          {instance && instance.min_age > 0 && <p className="auth-hint">You need to be at least {instance.min_age} years old.</p>}
        </div>
        {instance?.terms && (
          <label className={`auth-consent${errors.consent ? " error" : ""}`}>
            <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
            <span>
              {instance.terms}
              {instance.terms_url && (
                <>
                  {" "}
                  <a href={instance.terms_url} target="_blank" rel="noreferrer noopener">
                    Read the terms
                  </a>
                </>
              )}
            </span>
          </label>
        )}
        {errors.consent && <p className="field-error">{errors.consent}</p>}
        <button type="submit" className="btn btn-wide" disabled={busy}>
          Continue
        </button>
      </form>
      <OAuthButtons />
    </Frame>
  );
}
