// Small building blocks shared by the My Account dialogs.

import { useState, type FormEvent, type ReactNode } from "react";
import { Modal } from "../ui";
import { fieldErrors } from "../auth/ui";
import "./account.css";

/** A settings dialog with a form: Cancel + a primary submit button, field errors from the server. */
export function FormDialog({ title, subtitle, submitLabel, danger, onClose, onSubmit, children }: {
  title: string;
  subtitle?: ReactNode;
  submitLabel: string;
  danger?: boolean;
  onClose(): void;
  /** Throw to show the server's errors; resolve to close, or to "keep" to stay open (the dialog renders something else next). */
  onSubmit(): Promise<void | "keep">;
  children: (errors: Record<string, string>) => ReactNode;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setErrors({});
    try {
      if ((await onSubmit()) === "keep") setBusy(false);
      else onClose();
    } catch (error) {
      setErrors(fieldErrors(error));
      setBusy(false);
    }
  };
  const formId = `acct-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      className="acct-dialog"
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={formId} className={`btn${danger ? " btn-danger" : ""}`} disabled={busy}>
            {submitLabel}
          </button>
        </>
      }
    >
      <form id={formId} className="acct-form" onSubmit={submit} noValidate>
        {subtitle && <p className="acct-subtitle">{subtitle}</p>}
        {children(errors)}
        {errors._ && (
          <p className="field-error" role="alert">
            {errors._}
          </p>
        )}
      </form>
    </Modal>
  );
}

export function DialogField({ label, error, children, hint }: { label: string; error?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="acct-field">
      <label className={`field-label${error ? " error" : ""}`}>
        {label}
        {error && <span className="field-label-error"> - {error}</span>}
        {children}
      </label>
      {hint}
    </div>
  );
}
