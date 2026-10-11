// Kick / Ban / Timeout / Change Nickname modals (milestone D). Server errors (403 etc.) show inline like Confirm does.
import { useState, type ReactNode } from "react";
import { ApiRequestError } from "../api/errors";
import { request } from "../api/rest";
import { displayName, useStore } from "../api/store";
import type { EditMemberRequest, BanRequest, Snowflake } from "../api/types";
import { Modal } from "../ui";
import { closeModal } from "./modalStore";
import { RadioGroup, Select } from "./settings/controls";

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const field = error.api.errors && Object.values(error.api.errors)[0];
    const detail = field && typeof field === "object" && "message" in field ? String((field as { message: unknown }).message) : null;
    return detail ?? error.message;
  }
  return "Something went wrong. Try again.";
}

/** Shared shell: Cancel + action footer, busy state, inline error. */
function ModShell({ title, action, danger, onSubmit, children }: { title: string; action: string; danger?: boolean; onSubmit: () => Promise<unknown>; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    setBusy(true);
    setError(null);
    onSubmit()
      .then(closeModal)
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
          <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} disabled={busy} onClick={submit}>
            {action}
          </button>
        </>
      }
    >
      {children}
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}

function useTargetName(guildId: Snowflake, userId: Snowflake): string {
  const user = useStore(s => s.users[userId] ?? s.members[guildId]?.[userId]?.user);
  const member = useStore(s => s.members[guildId]?.[userId]);
  return user ? displayName(user, member) : "this member";
}

export function KickModal({ guildId, userId }: { guildId: Snowflake; userId: Snowflake }) {
  const name = useTargetName(guildId, userId);
  return (
    <ModShell title={`Kick ${name} from server`} action="Kick" danger onSubmit={() => request("DELETE", `/guilds/${guildId}/members/${userId}`)}>
      <p className="modal-text">Are you sure you want to kick {name} from the server? They will be able to rejoin again with a new invite.</p>
    </ModShell>
  );
}

const DELETE_OPTIONS = [
  { value: "0", label: "Don't delete any" },
  { value: "86400", label: "Previous 24 hours" },
  { value: "604800", label: "Previous 7 days" },
];

export function BanModal({ guildId, userId }: { guildId: Snowflake; userId: Snowflake }) {
  const name = useTargetName(guildId, userId);
  const [history, setHistory] = useState("0");
  const [reason, setReason] = useState("");
  return (
    <ModShell
      title={`Ban ${name} from server`}
      action="Ban"
      danger
      onSubmit={() => {
        const body: BanRequest = { delete_message_seconds: Number(history), ...(reason.trim() ? { reason: reason.trim() } : {}) };
        return request("PUT", `/guilds/${guildId}/bans/${userId}`, body);
      }}
    >
      <p className="modal-text">Are you sure you want to ban {name}? They will not be able to rejoin until unbanned.</p>
      <div className="field-label mod-reason-label">Delete message history</div>
      <div className="mod-field">
        <Select label="Delete message history" value={history} options={DELETE_OPTIONS} onChange={setHistory} />
      </div>
      <label className="field-label" htmlFor="mod-ban-reason">
        Reason for ban
      </label>
      <textarea id="mod-ban-reason" className="input mod-reason" value={reason} maxLength={512} placeholder="Optional" onChange={e => setReason(e.target.value)} />
    </ModShell>
  );
}

const TIMEOUT_OPTIONS = [
  { value: "60", label: "60 secs" },
  { value: "300", label: "5 mins" },
  { value: "600", label: "10 mins" },
  { value: "3600", label: "1 hour" },
  { value: "86400", label: "1 day" },
  { value: "604800", label: "1 week" },
];

export function TimeoutModal({ guildId, userId }: { guildId: Snowflake; userId: Snowflake }) {
  const name = useTargetName(guildId, userId);
  const [duration, setDuration] = useState("3600");
  const [reason, setReason] = useState("");
  return (
    <ModShell
      title={`Timeout ${name}`}
      action="Timeout"
      onSubmit={() => {
        const body: EditMemberRequest = { communication_disabled_until: new Date(Date.now() + Number(duration) * 1000).toISOString() };
        return request("PATCH", `/guilds/${guildId}/members/${userId}`, body);
      }}
    >
      <p className="modal-text">When you put a member in timeout they will not be able to send messages, react, or speak in voice channels.</p>
      <div className="field-label">Duration</div>
      <RadioGroup name="Timeout duration" value={duration} options={TIMEOUT_OPTIONS} onChange={setDuration} />
      <label className="field-label mod-reason-label" htmlFor="mod-timeout-reason">
        Reason
      </label>
      <textarea id="mod-timeout-reason" className="input mod-reason" value={reason} maxLength={512} placeholder="Optional" onChange={e => setReason(e.target.value)} />
    </ModShell>
  );
}

export function NicknameModal({ guildId, userId }: { guildId: Snowflake; userId: Snowflake }) {
  const user = useStore(s => s.users[userId] ?? s.members[guildId]?.[userId]?.user);
  const member = useStore(s => s.members[guildId]?.[userId]);
  const isMe = useStore(s => s.me?.id === userId);
  const [nick, setNick] = useState(member?.nick ?? "");
  return (
    <ModShell
      title="Change Nickname"
      action="Save"
      onSubmit={() => {
        const body: EditMemberRequest = { nick: nick.trim() === "" ? null : nick.trim() };
        return request("PATCH", `/guilds/${guildId}/members/${isMe ? "@me" : userId}`, body);
      }}
    >
      <label className="field-label" htmlFor="mod-nick">
        Nickname
      </label>
      <input id="mod-nick" className="input" autoFocus value={nick} maxLength={32} placeholder={user?.username ?? ""} onChange={e => setNick(e.target.value)} />
      <button type="button" className="btn btn-link mod-reset" onClick={() => setNick("")}>
        Reset Nickname
      </button>
    </ModShell>
  );
}
