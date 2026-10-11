// Disable / Delete Account. Rendered at the end of the Password & Security slot until the shell offers an Account Status slot.

import { useState } from "react";
import { clearSession } from "../api/auth";
import { SettingsRow } from "../shell/settings/SettingsModal";
import { deleteAccount, disableAccount } from "./api";
import { ConfirmIdentity, confirmBody, useConfirm } from "./Confirm";
import { FormDialog } from "./ui";

function RemovalDialog({ kind, onClose }: { kind: "disable" | "delete"; onClose(): void }) {
  const identity = useConfirm();
  const remove = kind === "disable" ? disableAccount : deleteAccount;
  return (
    <FormDialog
      title={kind === "disable" ? "Disable Account" : "Delete Account"}
      subtitle={
        kind === "disable"
          ? "Are you sure you want to disable your account? This logs you out everywhere. Log in again any time to turn it back on."
          : "Are you sure you want to delete your account? This can't be undone: your profile is removed, your messages stay and show as Deleted User."
      }
      submitLabel={kind === "disable" ? "Disable Account" : "Delete Account"}
      danger
      onClose={onClose}
      onSubmit={async () => {
        const { password, code } = confirmBody(identity, true);
        await remove(password, code);
        clearSession();
      }}
    >
      {errors => <ConfirmIdentity state={identity} errors={errors} codeWithPassword autoFocus />}
    </FormDialog>
  );
}

export function AccountRemoval() {
  const [open, setOpen] = useState<"disable" | "delete" | null>(null);
  return (
    <>
      <h3 className="sm-subhead">Account Removal</h3>
      <SettingsRow label="Disable Account" value={<span className="sm-muted">You can recover it by logging in again.</span>}>
        <button type="button" className="sm-btn" onClick={() => setOpen("disable")}>
          Disable Account
        </button>
      </SettingsRow>
      <SettingsRow label="Delete Account" value={<span className="sm-muted">Servers you own must be transferred or deleted first.</span>}>
        <button type="button" className="sm-btn danger" onClick={() => setOpen("delete")}>
          Delete Account
        </button>
      </SettingsRow>
      {open && <RemovalDialog kind={open} onClose={() => setOpen(null)} />}
    </>
  );
}
