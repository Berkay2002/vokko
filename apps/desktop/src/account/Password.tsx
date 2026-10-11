import { useState } from "react";
import { useStore } from "../api/store";
import { PasswordMeter } from "../auth/PasswordMeter";
import { SettingsRow } from "../shell/settings/SettingsModal";
import { accountStore, editAccount } from "./api";
import { ConfirmIdentity, confirmBody, useConfirm } from "./Confirm";
import { DialogField, FormDialog } from "./ui";

function PasswordDialog({ hasPassword, onClose, onDone }: { hasPassword: boolean; onClose(): void; onDone(): void }) {
  const me = useStore(s => s.me);
  const email = accountStore(s => s.info?.email ?? "");
  const identity = useConfirm();
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  return (
    <FormDialog
      title={hasPassword ? "Update your password" : "Set a password"}
      subtitle={hasPassword ? "Enter your current password and a new password. Your other sessions will be logged out." : "Add a password so you can also log in with your email or username."}
      submitLabel="Done"
      onClose={onClose}
      onSubmit={async () => {
        if (next !== confirm) throw new Error("The new passwords don't match.");
        await editAccount({ new_password: next, ...confirmBody(identity) });
        onDone();
      }}
    >
      {errors => (
        <>
          <ConfirmIdentity state={identity} errors={errors} autoFocus />
          <DialogField label="New Password" error={errors.new_password} hint={<PasswordMeter password={next} personal={[me?.username ?? "", email]} />}>
            <input className="input" type="password" value={next} autoFocus={!hasPassword} autoComplete="new-password" onChange={e => setNext(e.target.value)} />
          </DialogField>
          <DialogField label="Confirm New Password">
            <input className="input" type="password" value={confirm} autoComplete="new-password" onChange={e => setConfirm(e.target.value)} />
          </DialogField>
        </>
      )}
    </FormDialog>
  );
}

export function PasswordRow() {
  const hasPassword = accountStore(s => s.info?.has_password ?? true);
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  return (
    <>
      <SettingsRow label="Password" value={done ? "Password changed. Your other sessions were logged out." : hasPassword ? "********" : <span className="sm-muted">No password set</span>}>
        <button type="button" className="sm-btn primary" onClick={() => setOpen(true)}>
          {hasPassword ? "Change Password" : "Set Password"}
        </button>
      </SettingsRow>
      {open && <PasswordDialog hasPassword={hasPassword} onClose={() => setOpen(false)} onDone={() => setDone(true)} />}
    </>
  );
}
