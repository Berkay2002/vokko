import { useEffect, useState } from "react";
import { ApiRequestError } from "../api/errors";
import { gateway } from "../api/gateway";
import { request } from "../api/rest";
import { useStore } from "../api/store";
import type { GuildJoinRequest, Invite, MemberVerificationField, MemberVerificationForm } from "../api/types";
import { errorText } from "../shell/inviteView";
import { go, guildPath } from "../shell/nav";
import { Modal } from "../ui";

type Load = { status: "loading" } | { status: "failed"; message: string } | { status: "ready"; invite: Invite; form: MemberVerificationForm; request: GuildJoinRequest | null };

const noRequest = (e: unknown): null => {
  if (e instanceof ApiRequestError && e.status === 404) return null;
  throw e;
};

/** Everything an applicant sees: the form, then "Application pending" (Withdraw), "Rejected" (Apply again), and the server opening once approved. */
export function ApplyToJoin({ code, onClose }: { code: string; onClose(): void }) {
  const meId = useStore(s => s.me?.id);
  const guilds = useStore(s => s.guilds);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [answers, setAnswers] = useState<(MemberVerificationField["response"])[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const guildId = load.status === "ready" ? load.invite.guild.id : null;

  useEffect(() => {
    let live = true;
    const c = encodeURIComponent(code);
    void (async () => {
      try {
        const invite = await request<Invite>("GET", `/invites/${c}`);
        const [form, current] = await Promise.all([
          request<MemberVerificationForm>("GET", `/guilds/${invite.guild.id}/member-verification?invite_code=${c}`),
          request<GuildJoinRequest>("GET", `/guilds/${invite.guild.id}/requests/@me`).catch(noRequest),
        ]);
        if (live) {
          setAnswers(form.form_fields.map(() => null));
          setLoad({ status: "ready", invite, form, request: current });
        }
      } catch (e) {
        if (live) setLoad({ status: "failed", message: errorText(e, "Could not load this application.") });
      }
    })();
    return () => {
      live = false;
    };
  }, [code]);

  useEffect(() => {
    if (!guildId || !meId) return;
    const set = (next: GuildJoinRequest | null, only?: string) =>
      setLoad(l => (l.status === "ready" && (only === undefined || l.request?.id === only) ? { ...l, request: next } : l));
    const mine = (e: { guild_id: string; request: GuildJoinRequest }) => e.guild_id === guildId && e.request.user_id === meId;
    const offs = [
      gateway.on("GUILD_JOIN_REQUEST_CREATE", e => mine(e) && set(e.request)),
      gateway.on("GUILD_JOIN_REQUEST_UPDATE", e => mine(e) && set(e.request)),
      gateway.on("GUILD_JOIN_REQUEST_DELETE", e => e.guild_id === guildId && e.user_id === meId && set(null, e.id)),
    ];
    return () => offs.forEach(off => off());
  }, [guildId, meId]);

  // Approval adds the member (GUILD_CREATE): the server opens.
  const joined = !!guildId && !!guilds[guildId];
  useEffect(() => {
    if (!joined || !guildId) return;
    onClose();
    go(guildPath(guildId));
  }, [joined, guildId, onClose]);

  if (load.status !== "ready") {
    return (
      <Modal open onClose={onClose} title="Apply to Join">
        {load.status === "loading" ? <p className="modal-text center">Loading…</p> : <p className="field-error" role="alert">{load.message}</p>}
      </Modal>
    );
  }
  const { invite, form, request: current } = load;
  const fields = form.form_fields;
  const title = `Apply to join ${invite.guild.name}`;
  const base = `/guilds/${invite.guild.id}/requests/@me`;

  const act = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(errorText(e, "Something went wrong. Try again."));
    } finally {
      setBusy(false);
    }
  };

  // An approved request of someone who left again falls through to the form (the server lets them reapply).
  if (current?.application_status === "SUBMITTED" || (current?.application_status === "APPROVED" && joined)) {
    const approved = current.application_status === "APPROVED";
    return (
      <Modal
        open
        onClose={onClose}
        title={approved ? "Application approved" : "Application pending"}
        footer={
          approved ? undefined : (
            <>
              <button type="button" className="btn btn-link" onClick={onClose}>
                Close
              </button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void act(async () => { await request<void>("DELETE", base); setLoad({ ...load, request: null }); })}>
                Withdraw
              </button>
            </>
          )
        }
      >
        <p className="modal-text center">{approved ? "You are in. Opening the server…" : `Your application to ${invite.guild.name} was sent. You will get in once a moderator approves it.`}</p>
        {error && <p className="field-error" role="alert">{error}</p>}
      </Modal>
    );
  }

  const set = (i: number, value: MemberVerificationField["response"]) => setAnswers(a => a.map((v, j) => (j === i ? value : v)));
  const complete = fields.every((f, i) => !f.required || (f.field_type === "TERMS" ? answers[i] === true : typeof answers[i] === "number" || (typeof answers[i] === "string" && (answers[i] as string).trim() !== "")));
  const submit = () =>
    act(async () => {
      const sent = await request<GuildJoinRequest>("PUT", base, { invite_code: code, form_fields: fields.map((f, i) => ({ ...f, response: answers[i] ?? null })) });
      setLoad({ ...load, request: sent });
    });

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      className="apply-modal"
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !complete} onClick={() => void submit()}>
            {current ? "Apply again" : "Submit"}
          </button>
        </>
      }
    >
      {current?.application_status === "REJECTED" && (
        <p className="field-error" role="status">
          Your application was rejected{current.rejection_reason ? `: ${current.rejection_reason}` : "."}
        </p>
      )}
      {form.description && <p className="modal-text apply-description">{form.description}</p>}
      {fields.length === 0 && <p className="modal-text">A moderator will review your application.</p>}
      {fields.map((f, i) => {
        const id = `apply-${i}`;
        const label = (
          <span className="field-label">
            {f.label} {f.required && <span className="required">*</span>}
          </span>
        );
        if (f.field_type === "TERMS")
          return (
            <div key={i} className="apply-field">
              {label}
              <ol className="apply-rules">
                {f.values?.map((rule, r) => (
                  <li key={r}>{rule}</li>
                ))}
              </ol>
              <label className="apply-check">
                <input type="checkbox" checked={answers[i] === true} onChange={e => set(i, e.target.checked ? true : null)} /> I have read and agree to the rules
              </label>
            </div>
          );
        if (f.field_type === "MULTIPLE_CHOICE")
          return (
            <div key={i} className="apply-field" role="radiogroup" aria-label={f.label}>
              {label}
              {f.values?.map((choice, c) => (
                <label key={c} className="apply-check">
                  <input type="radio" name={id} checked={answers[i] === c} onChange={() => set(i, c)} /> {choice}
                </label>
              ))}
            </div>
          );
        return (
          <div key={i} className="apply-field">
            <label htmlFor={id}>{label}</label>
            {f.field_type === "PARAGRAPH" ? (
              <textarea id={id} className="input" rows={4} maxLength={1000} placeholder={f.placeholder ?? undefined} value={(answers[i] as string | null) ?? ""} onChange={e => set(i, e.target.value)} />
            ) : (
              <input id={id} className="input" maxLength={150} placeholder={f.placeholder ?? undefined} value={(answers[i] as string | null) ?? ""} onChange={e => set(i, e.target.value)} />
            )}
          </div>
        );
      })}
      {error && <p className="field-error" role="alert">{error}</p>}
    </Modal>
  );
}
