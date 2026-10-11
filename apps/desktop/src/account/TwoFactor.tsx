// Authenticator app (TOTP) two-factor: enable with a QR code, backup codes, remove.

import { useMemo, useState } from "react";
import { request } from "../api/rest";
import { useStore } from "../api/store";
import type { BackupCode, BackupCodesResponse } from "../api/types";
import { SettingsRow } from "../shell/settings/SettingsModal";
import { Modal } from "../ui";
import { accountStore, loadAccount } from "./api";
import { QrCode } from "./QrCode";
import { ConfirmIdentity, confirmBody, useConfirm } from "./Confirm";
import { DialogField, FormDialog } from "./ui";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 160 random bits as base32 (32 chars), the size authenticator apps expect. */
export function newSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => BASE32[byte % 32]).join("");
}

export function otpauthUri(secret: string, account: string, issuer: string): string {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function BackupCodesDialog({ codes, onClose, onRegenerate }: { codes: BackupCode[]; onClose(): void; onRegenerate?(): void }) {
  const shown = codes.some(c => c.code);
  return (
    <Modal
      open
      onClose={onClose}
      title="Backup Codes"
      className="acct-dialog"
      footer={
        <>
          {onRegenerate && (
            <button type="button" className="btn btn-link" onClick={onRegenerate}>
              Generate New Codes
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="acct-form">
        <p className="acct-subtitle">
          {shown
            ? "Save these codes somewhere safe. Each one signs you in once if you lose your authenticator app. They won't be shown again."
            : "Your codes are stored only as hashes, so they can't be shown again. Crossed-out codes were used. Generate new codes if you lost them."}
        </p>
        <ul className="acct-codes" aria-label="Backup codes">
          {codes.map((c, i) => (
            <li key={c.code ?? i} className={c.consumed ? "used" : undefined}>
              {c.code ? `${c.code.slice(0, 4)}-${c.code.slice(4)}` : `Code ${i + 1}: ${c.consumed ? "used" : "unused"}`}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

function EnableDialog({ onClose, onEnabled }: { onClose(): void; onEnabled(codes: BackupCode[]): void }) {
  const me = useStore(s => s.me);
  const secret = useMemo(newSecret, []);
  const [code, setCode] = useState("");
  const identity = useConfirm();
  const issuer = typeof window === "undefined" ? "Vokko" : `Vokko (${window.location.hostname || "desktop"})`;
  const uri = otpauthUri(secret, me?.username ?? "account", issuer);
  return (
    <FormDialog
      title="Enable Authenticator App"
      submitLabel="Activate"
      onClose={onClose}
      onSubmit={async () => {
        const result = await request<BackupCodesResponse>("POST", "/users/@me/mfa/totp/enable", { secret, code: code.trim(), ...confirmBody(identity) });
        await loadAccount();
        onEnabled(result.backup_codes);
      }}
    >
      {errors => (
        <>
          <div className="acct-qr">
            <QrCode data={uri} label="QR code for your authenticator app" />
            <div>
              <p className="acct-subtitle">Scan this QR code with an authenticator app (Aegis, 2FAS, Google Authenticator, 1Password...). Or enter this key:</p>
              <p className="acct-secret" data-testid="totp-secret">
                {secret.match(/.{1,4}/g)?.join(" ")}
              </p>
            </div>
          </div>
          <DialogField label="6-digit code from the app" error={errors.code ?? errors.secret}>
            <input className="input" value={code} inputMode="numeric" maxLength={6} autoComplete="one-time-code" autoFocus onChange={e => setCode(e.target.value)} />
          </DialogField>
          {errors.email && (
            <p className="field-error" role="alert">
              {errors.email}
            </p>
          )}
          <ConfirmIdentity state={identity} errors={errors} />
        </>
      )}
    </FormDialog>
  );
}

function CodeDialog({ title, subtitle, submitLabel, onClose, onSubmit }: { title: string; subtitle: string; submitLabel: string; onClose(): void; onSubmit(code: string): Promise<void> }) {
  const [code, setCode] = useState("");
  return (
    <FormDialog title={title} subtitle={subtitle} submitLabel={submitLabel} danger onClose={onClose} onSubmit={() => onSubmit(code.trim())}>
      {errors => (
        <DialogField label="Authentication or backup code" error={errors.code}>
          <input className="input" value={code} autoFocus autoComplete="one-time-code" onChange={e => setCode(e.target.value)} />
        </DialogField>
      )}
    </FormDialog>
  );
}

function ViewCodesDialog({ onClose }: { onClose(): void }) {
  const identity = useConfirm();
  const [codes, setCodes] = useState<BackupCode[] | null>(null);
  const fetchCodes = async (regenerate: boolean) => {
    const result = await request<BackupCodesResponse>("POST", "/users/@me/mfa/codes-verification", { regenerate, ...confirmBody(identity) });
    setCodes(result.backup_codes);
  };
  if (codes) return <BackupCodesDialog codes={codes} onClose={onClose} onRegenerate={codes.some(c => c.code) ? undefined : () => void fetchCodes(true)} />;
  return (
    <FormDialog
      title="View Backup Codes"
      subtitle="Confirm it's you to see your backup codes."
      submitLabel="Continue"
      onClose={onClose}
      onSubmit={async () => {
        await fetchCodes(false);
        return "keep";
      }}
    >
      {errors => <ConfirmIdentity state={identity} errors={errors} autoFocus />}
    </FormDialog>
  );
}

export function TwoFactorRows() {
  const info = accountStore(s => s.info);
  const [dialog, setDialog] = useState<"enable" | "remove" | "codes" | null>(null);
  const [fresh, setFresh] = useState<BackupCode[] | null>(null);
  if (!info) return null;
  const close = () => setDialog(null);
  return (
    <>
      <h3 className="sm-subhead">Authenticator App</h3>
      {info.mfa_enabled ? (
        <>
          <SettingsRow label="Two-Factor Authentication" value="Enabled. Logging in asks for a code from your authenticator app.">
            <button type="button" className="sm-btn" onClick={() => setDialog("codes")}>
              View Backup Codes
            </button>
            <button type="button" className="sm-btn danger" onClick={() => setDialog("remove")}>
              Remove Authenticator App
            </button>
          </SettingsRow>
        </>
      ) : (
        <SettingsRow label="Two-Factor Authentication" value={<span className="sm-muted">Protect your account with a code from an authenticator app.</span>}>
          <button type="button" className="sm-btn primary" onClick={() => setDialog("enable")}>
            Enable Authenticator App
          </button>
        </SettingsRow>
      )}
      {dialog === "enable" && (
        <EnableDialog
          onClose={close}
          onEnabled={codes => setFresh(codes)}
        />
      )}
      {dialog === "remove" && (
        <CodeDialog
          title="Remove Authenticator App"
          subtitle="Enter a code from your authenticator app or a backup code to turn two-factor off."
          submitLabel="Remove"
          onClose={close}
          onSubmit={async code => {
            await request<void>("POST", "/users/@me/mfa/totp/disable", { code });
            await loadAccount();
          }}
        />
      )}
      {dialog === "codes" && <ViewCodesDialog onClose={close} />}
      {fresh && <BackupCodesDialog codes={fresh} onClose={() => setFresh(null)} />}
    </>
  );
}
