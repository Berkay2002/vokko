// "Report a problem" (Help menu, Settings > Advanced, the voice connection popout): a short description plus the app version,
// the OS and the scrubbed log ring go to the server, where the instance operator reads them. The user can see what is sent.
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { version as packageVersion } from "../../package.json";
import { ApiRequestError, RateLimitedError } from "../api/errors";
import { createBugReport } from "../api/rest";
import { BUG_REPORT_DESCRIPTION_MAX } from "../api/types";
import { getAppVersion } from "../desktop";
import { recentLogs } from "../report/logBuffer";
import { Modal, announce } from "../ui";
import { closeModal } from "./modalStore";

/** The server caps the whole body at 256 KiB; the log tail is cut from the front to stay well under it. */
const MAX_LOG_CHARS = 200_000;

function errorText(error: unknown): string {
  if (error instanceof RateLimitedError) return `You've sent several reports already. Try again in ${Math.max(1, Math.ceil(error.retryAfter / 60))} minutes.`;
  if (error instanceof ApiRequestError) return error.message;
  return "Something went wrong. Try again.";
}

export function ReportProblemModal() {
  const [description, setDescription] = useState("");
  const [version, setVersion] = useState(`web ${packageVersion}`);
  const [showSent, setShowSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);
  // a snapshot: lines logged while the dialog is open (our own request included) are not sent
  const [logs] = useState(() => recentLogs().slice(-MAX_LOG_CHARS));
  const os = navigator.userAgent.slice(0, 256);

  useEffect(() => {
    let live = true;
    void getAppVersion().then(v => live && v && setVersion(v));
    return () => {
      live = false;
    };
  }, []);

  const submit = () => {
    if (description.trim() === "") return;
    setBusy(true);
    setError(null);
    createBugReport({ description: description.trim(), app_version: version, os, logs })
      .then(created => {
        setSentId(created.id);
        announce("Report sent.");
      })
      .catch(e => {
        setError(errorText(e));
        setBusy(false);
      });
  };

  if (sentId)
    return (
      <Modal
        open
        onClose={closeModal}
        title="Report Sent"
        className="report-problem"
        footer={
          <button type="button" className="btn btn-primary" onClick={closeModal}>
            Done
          </button>
        }
      >
        <p className="modal-text">Thanks. Your report was sent to whoever runs this Vokko server.</p>
        <p className="settings-field-note">Reference: {sentId}</p>
      </Modal>
    );

  return (
    <Modal
      open
      onClose={closeModal}
      title="Report a Problem"
      className="report-problem"
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={closeModal}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || description.trim() === ""} onClick={submit}>
            Send Report
          </button>
        </>
      }
    >
      <label className="field-label" htmlFor="report-problem-text">
        What went wrong?
      </label>
      <textarea
        id="report-problem-text"
        className="input mod-reason"
        value={description}
        maxLength={BUG_REPORT_DESCRIPTION_MAX}
        placeholder="Describe the problem and what you expected to happen"
        autoFocus
        onChange={e => setDescription(e.target.value)}
      />
      <p className="settings-field-note">Attached: app version, OS, and recent warnings, errors and voice events with tokens removed. No message content is included.</p>
      <button type="button" className="report-problem-toggle" aria-expanded={showSent} aria-controls="report-problem-sent" onClick={() => setShowSent(s => !s)}>
        {showSent ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />} Show what is sent
      </button>
      {showSent && (
        <pre id="report-problem-sent" className="report-problem-sent" tabIndex={0}>
          {`app_version: ${version}\nos: ${os}\n${logs || "(no log lines yet)"}`}
        </pre>
      )}
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}
