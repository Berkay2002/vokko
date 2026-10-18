// Shared pieces of the signed-out screens: the card frame, labelled fields and server error mapping.

import type { ReactNode } from "react";
import { ApiRequestError } from "../api/errors";
import logo from "../../../../assets/brand/vokko-icon.svg";
import "./auth.css";

/** Field errors of a 50035 response (both the server's `{field: {_errors: [{message}]}}` and the flat `{field: {message}}`), `_` for the rest. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiRequestError)) return { _: error instanceof Error ? error.message : "Something went wrong." };
  const out: Record<string, string> = {};
  const errors = error.api.errors ?? {};
  for (const [field, value] of Object.entries(errors)) {
    const entry = value as { message?: string; _errors?: { message?: string }[] } | undefined;
    const message = entry?.message ?? entry?._errors?.[0]?.message;
    if (message) out[field] = message;
  }
  if (Object.keys(out).length === 0) {
    if (error.status === 429) out._ = "You are being rate limited. Try again in a moment.";
    else out._ = error.message;
  }
  return out;
}

export function Field({ label, error, required, children, hint }: { label: string; error?: string; required?: boolean; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="auth-field">
      <label className={`field-label${error ? " error" : ""}`}>
        {label}
        {required && <span className="required"> *</span>}
        {error && <span className="field-label-error"> - {error}</span>}
        {children}
      </label>
      {hint}
    </div>
  );
}

export function Frame({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <img className="auth-logo" src={logo} alt="" width={48} height={48} />
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {children}
        {footer && <div className="auth-footer">{footer}</div>}
      </div>
    </div>
  );
}

/** A form's wide submit button. While `busy` it keeps its size and shows pulsing dots in place of the label (still read out). */
export function SubmitButton({ busy, disabled, children }: { busy: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="submit" className="btn btn-wide auth-submit" disabled={busy || disabled} aria-busy={busy}>
      <span className={busy ? "auth-submit-label hidden" : "auth-submit-label"}>{children}</span>
      {busy && (
        <span className="auth-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
    </button>
  );
}

/** The token of a `#token=...` link (kept in the fragment so it never reaches server logs). */
export function tokenFromHash(hash: string): string {
  return new URLSearchParams(hash.replace(/^#/, "")).get("token") ?? "";
}
