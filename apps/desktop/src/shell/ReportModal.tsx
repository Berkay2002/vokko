// Report Message / Report User (MOD-009): pick a reason, add optional details. Server errors show inline; success closes and toasts.
import { useState } from "react";
import { ApiRequestError, RateLimitedError } from "../api/errors";
import { reportMember, reportMessage } from "../api/rest";
import { displayName, useStore } from "../api/store";
import { REPORT_DETAILS_MAX, type CreateReportRequest, type ReportReason, type Snowflake } from "../api/types";
import { chatToast } from "../chat/toast";
import { Modal } from "../ui";
import { closeModal } from "./modalStore";
import { RadioGroup } from "./settings/controls";

export type ReportTarget = { kind: "message"; channelId: Snowflake; messageId: Snowflake; /** A DM message goes to the instance operator, not to guild moderators. */ dm: boolean } | { kind: "user"; guildId: Snowflake; userId: Snowflake };

export const REPORT_REASONS: { value: ReportReason; label: string }[] = [
  { value: "spam", label: "Spam" },
  { value: "harassment", label: "Harassment or bullying" },
  { value: "hate", label: "Hate speech" },
  { value: "sexual", label: "Sexual content" },
  { value: "violence", label: "Violence or threats" },
  { value: "self_harm", label: "Self-harm" },
  { value: "impersonation", label: "Impersonation" },
  { value: "other", label: "Something else" },
];

function errorText(error: unknown): string {
  if (error instanceof RateLimitedError) return `You're reporting too fast. Try again in ${Math.max(1, Math.ceil(error.retryAfter))} seconds.`;
  if (error instanceof ApiRequestError) {
    const field = error.api.errors && Object.values(error.api.errors)[0];
    const detail = field && typeof field === "object" && "message" in field ? String((field as { message: unknown }).message) : null;
    return detail ?? error.message;
  }
  return "Something went wrong. Try again.";
}

export function ReportModal({ target }: { target: ReportTarget }) {
  const userId = target.kind === "user" ? target.userId : null;
  const guildId = target.kind === "user" ? target.guildId : null;
  const user = useStore(s => (userId ? s.users[userId] ?? (guildId ? s.members[guildId]?.[userId]?.user : undefined) : undefined));
  const member = useStore(s => (userId && guildId ? s.members[guildId]?.[userId] : undefined));
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = target.kind === "message" ? "Report Message" : `Report ${user ? displayName(user, member) : "User"}`;
  const submit = () => {
    if (!reason) return;
    const body: CreateReportRequest = { reason, details: details.trim() === "" ? null : details.trim() };
    setBusy(true);
    setError(null);
    (target.kind === "message" ? reportMessage(target.channelId, target.messageId, body) : reportMember(target.guildId, target.userId, body))
      .then(() => {
        closeModal();
        chatToast(target.kind === "message" && target.dm ? "Thanks for your report. It is kept for this server's operator." : "Thanks for your report. The server's moderators will review it.");
      })
      .catch(e => {
        setError(errorText(e));
        setBusy(false);
      });
  };
  return (
    <Modal
      open
      onClose={closeModal}
      title={title}
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={closeModal}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={busy || !reason} onClick={submit}>
            Report
          </button>
        </>
      }
    >
      <p className="modal-text">{target.kind === "message" ? "Why are you reporting this message?" : "Why are you reporting this member?"}</p>
      <RadioGroup<ReportReason> name="Report reason" value={reason ?? ("" as ReportReason)} options={REPORT_REASONS} onChange={next => setReason(next)} disabled={busy} />
      <label className="field-label mod-reason-label" htmlFor="report-details">
        Details
      </label>
      <textarea id="report-details" className="input mod-reason" value={details} maxLength={REPORT_DETAILS_MAX} placeholder="Optional" onChange={e => setDetails(e.target.value)} />
      <p className="settings-field-note">
        {target.kind === "message" && target.dm
          ? "Direct messages have no moderators: the report is kept for whoever runs this Vokko server."
          : "Moderators of this server will see that you sent this report."}
      </p>
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}
