// "Is it really you?" fields of the sensitive My Account dialogs (docs/api.md, security rules):
// password accounts type their password; accounts without one give a two-factor code when it is on,
// otherwise they re-confirm through a linked provider when the server answers `reauth`.

import { useEffect, useState } from "react";
import { request } from "../api/rest";
import type { LinkedProvider } from "../api/types";
import { startOAuth } from "../auth/oauth";
import { accountStore } from "./api";
import { DialogField } from "./ui";

export interface ConfirmState {
  password: string;
  code: string;
  setPassword(value: string): void;
  setCode(value: string): void;
}

export function useConfirm(): ConfirmState {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  return { password, code, setPassword, setCode };
}

/** What to send: `password` for password accounts, `code` when two-factor applies. */
export function confirmBody(state: ConfirmState, codeWithPassword = false): { password?: string; code?: string } {
  const info = accountStore.getState().info;
  const hasPassword = info?.has_password ?? true;
  const mfa = info?.mfa_enabled ?? false;
  return {
    ...(hasPassword ? { password: state.password } : {}),
    ...(mfa && (!hasPassword || codeWithPassword) ? { code: state.code.trim() } : {}),
  };
}

function Reconfirm({ message }: { message: string }) {
  const [linked, setLinked] = useState<LinkedProvider[]>([]);
  useEffect(() => {
    request<LinkedProvider[]>("GET", "/users/@me/oauth").then(setLinked, () => setLinked([]));
  }, []);
  return (
    <div className="acct-notice warning" role="alert">
      <p>{message}</p>
      {linked.map(provider => (
        <button key={provider.provider} type="button" className="sm-btn primary acct-reconfirm" onClick={() => void startOAuth(provider.provider, true)}>
          Confirm with {provider.name}
        </button>
      ))}
    </div>
  );
}

export function ConfirmIdentity({ state, errors, codeWithPassword = false, autoFocus = false }: {
  state: ConfirmState;
  errors: Record<string, string>;
  codeWithPassword?: boolean;
  autoFocus?: boolean;
}) {
  const info = accountStore(s => s.info);
  const hasPassword = info?.has_password ?? true;
  const mfa = info?.mfa_enabled ?? false;
  return (
    <>
      {hasPassword && (
        <DialogField label="Current Password" error={errors.password}>
          <input className="input" type="password" value={state.password} autoFocus={autoFocus} autoComplete="current-password" onChange={e => state.setPassword(e.target.value)} />
        </DialogField>
      )}
      {mfa && (!hasPassword || codeWithPassword) && (
        <DialogField label="Authentication or backup code" error={errors.code}>
          <input className="input" value={state.code} autoComplete="one-time-code" onChange={e => state.setCode(e.target.value)} />
        </DialogField>
      )}
      {errors.reauth && <Reconfirm message={errors.reauth} />}
    </>
  );
}
