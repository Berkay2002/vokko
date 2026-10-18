// The "Account Info" rows of My Account (settings slot `accountIdentity`): display name, username and email.

import { useEffect, useState, type ReactNode } from "react";
import { ApiRequestError } from "../api/errors";
import { request } from "../api/rest";
import { appStore, displayName } from "../api/store";
import type { User } from "../api/types";
import { SettingsRow } from "../shell/settings/SettingsModal";
import { UsernameHint, useUsernameCheck } from "../auth/useUsernameCheck";
import { accountStore, editAccount, loadAccount, maskEmail, resendVerification } from "./api";
import { ConfirmIdentity, confirmBody, useConfirm } from "./Confirm";
import { DialogField, FormDialog } from "./ui";

function DisplayNameRow({ me }: { me: User }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(me.global_name ?? "");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const unchanged = name.trim() === (me.global_name ?? "");
  const submit = async () => {
    setState({ busy: true, error: null });
    try {
      const user = await request<User>("PATCH", "/users/@me", { global_name: name.trim() });
      appStore.getState().setMe(user);
      appStore.getState().cacheUsers([user]);
      setState({ busy: false, error: null });
      setEditing(false);
    } catch (error) {
      setState({ busy: false, error: error instanceof ApiRequestError ? error.message : "Something went wrong. Try again." });
    }
  };
  if (!editing) {
    return (
      <SettingsRow label="Display Name" value={displayName(me)}>
        <button type="button" className="sm-btn" onClick={() => setEditing(true)}>
          Edit
        </button>
      </SettingsRow>
    );
  }
  return (
    <>
      <SettingsRow label="Display Name">
        <input
          className="input sm-row-input"
          aria-label="Display Name"
          value={name}
          maxLength={32}
          placeholder={me.username}
          autoFocus
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !unchanged && !state.busy) void submit();
          }}
        />
        <button type="button" className="sm-btn" onClick={() => { setEditing(false); setName(me.global_name ?? ""); }}>
          Cancel
        </button>
        <button type="button" className="sm-btn primary" disabled={state.busy || unchanged} onClick={() => void submit()}>
          Save
        </button>
      </SettingsRow>
      {state.error && <p className="field-error">{state.error}</p>}
    </>
  );
}

function UsernameDialog({ me, hasPassword, onClose }: { me: User; hasPassword: boolean; onClose(): void }) {
  const [username, setUsername] = useState(me.username);
  const confirm = useConfirm();
  const status = useUsernameCheck(username, me.username);
  return (
    <FormDialog
      title="Change your username"
      subtitle={hasPassword ? "Enter a new username and your existing password." : "Enter a new username."}
      submitLabel="Done"
      onClose={onClose}
      onSubmit={async () => {
        await editAccount({ username, ...confirmBody(confirm) });
      }}
    >
      {errors => (
        <>
          <DialogField label="Username" error={errors.username} hint={<UsernameHint status={status} />}>
            <input className="input" value={username} maxLength={32} autoFocus spellCheck={false} onChange={e => setUsername(e.target.value)} />
          </DialogField>
          <ConfirmIdentity state={confirm} errors={errors} />
        </>
      )}
    </FormDialog>
  );
}

function EmailDialog({ email, onClose }: { email: string; onClose(): void }) {
  const [next, setNext] = useState("");
  const confirm = useConfirm();
  return (
    <FormDialog
      title="Enter an email address"
      subtitle={`We'll send a verification link to the new address. ${email} stays your email until you open it.`}
      submitLabel="Done"
      onClose={onClose}
      onSubmit={async () => {
        await editAccount({ email: next, ...confirmBody(confirm) });
      }}
    >
      {errors => (
        <>
          <DialogField label="Email" error={errors.email}>
            <input className="input" type="email" value={next} autoFocus autoComplete="email" onChange={e => setNext(e.target.value)} />
          </DialogField>
          <ConfirmIdentity state={confirm} errors={errors} />
        </>
      )}
    </FormDialog>
  );
}

function VerificationNotice({ text }: { text: ReactNode }) {
  const [sent, setSent] = useState<"idle" | "sent" | "failed">("idle");
  return (
    <div className="acct-notice warning" role="status">
      {text}{" "}
      {sent === "sent" ? (
        "Sent! Check your inbox."
      ) : (
        <button type="button" className="acct-reveal" onClick={() => resendVerification().then(() => setSent("sent"), () => setSent("failed"))}>
          {sent === "failed" ? "Couldn't send, try again" : "Resend link"}
        </button>
      )}
    </div>
  );
}

export function AccountIdentity({ me }: { me: User }) {
  const info = accountStore(s => s.info);
  const failed = accountStore(s => s.error !== null);
  const ready = appStore(s => s.connection === "ready");
  const [reveal, setReveal] = useState(false);
  const [dialog, setDialog] = useState<"username" | "email" | null>(null);
  // reload when the gateway comes back; a drop alone keeps what is already shown
  useEffect(() => {
    if (ready || !accountStore.getState().info) void loadAccount();
  }, [me.id, ready]);
  const hasPassword = info?.has_password ?? true;
  return (
    <>
      <DisplayNameRow me={me} />
      <SettingsRow label="Username" value={<span className="personal-info">{me.username}</span>}>
        <button type="button" className="sm-btn" onClick={() => setDialog("username")}>
          Edit
        </button>
      </SettingsRow>
      <SettingsRow
        label="Email"
        value={
          info ? (
            <>
              {/* Streamer Mode "hide personal information" blurs it (styles/settings.css) */}
              <span className="personal-info">{reveal ? info.email : maskEmail(info.email)}</span>
              <button type="button" className="acct-reveal" onClick={() => setReveal(r => !r)}>
                {reveal ? "Hide" : "Reveal"}
              </button>
            </>
          ) : failed ? (
            <>
              <span className="field-error">Couldn't load your email.</span>
              <button type="button" className="acct-reveal" onClick={() => void loadAccount()}>
                Retry
              </button>
            </>
          ) : (
            <span className="sm-muted">Loading...</span>
          )
        }
      >
        <button type="button" className="sm-btn" disabled={!info} onClick={() => setDialog("email")}>
          Edit
        </button>
      </SettingsRow>
      {info?.pending_email && <VerificationNotice text={<>We sent a verification link to <span className="personal-info">{info.pending_email}</span>. Your email changes once you open it.</>} />}
      {info && !info.pending_email && !info.verified && <VerificationNotice text="Your email isn't verified yet. Check your inbox for the link." />}
      {dialog === "username" && <UsernameDialog me={me} hasPassword={hasPassword} onClose={() => setDialog(null)} />}
      {dialog === "email" && info && <EmailDialog email={info.email} onClose={() => setDialog(null)} />}
    </>
  );
}
