// "Sign-in Methods" of My Account (settings slot `signInMethods`): link and unlink GitHub / Google / OIDC providers.

import { useEffect, useState } from "react";
import { request } from "../api/rest";
import type { AuthProvider, LinkedProvider } from "../api/types";
import { fieldErrors } from "../auth/ui";
import { fetchProviders, startOAuth } from "../auth/oauth";
import { ProviderIcon } from "../auth/ProviderIcon";
import { SettingsRow } from "../shell/settings/SettingsModal";
import { accountStore } from "./api";
import { ConfirmIdentity, confirmBody, useConfirm } from "./Confirm";
import { FormDialog } from "./ui";

function LinkDialog({ provider, onClose }: { provider: { id: string; name: string }; onClose(): void }) {
  const identity = useConfirm();
  return (
    <FormDialog
      title={`Link ${provider.name}`}
      subtitle={`Confirm it's you, then sign in to ${provider.name} to link it.`}
      submitLabel="Continue"
      onClose={onClose}
      onSubmit={async () => {
        await startOAuth(provider.id, true, confirmBody(identity));
        return "keep";
      }}
    >
      {errors => <ConfirmIdentity state={identity} errors={errors} autoFocus />}
    </FormDialog>
  );
}

export function SignInMethods() {
  const hasPassword = accountStore(s => s.info?.has_password ?? true);
  const mfa = accountStore(s => s.info?.mfa_enabled ?? false);
  // a stolen session alone must not add a sign-in method: password or two-factor accounts confirm first
  const needsConfirm = hasPassword || mfa;
  const [linking, setLinking] = useState<{ id: string; name: string } | null>(null);
  const [providers, setProviders] = useState<AuthProvider[] | null>(null);
  const [linked, setLinked] = useState<LinkedProvider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    const [all, mine] = await Promise.all([fetchProviders(), request<LinkedProvider[]>("GET", "/users/@me/oauth")]);
    setProviders(all);
    setLinked(mine);
  };
  useEffect(() => {
    load().catch(() => setError("Couldn't load your sign-in methods."));
  }, []);
  if (error && !providers) return <p className="field-error">{error}</p>;
  if (!providers) return <p className="sm-muted">Loading...</p>;
  if (providers.length === 0 && linked.length === 0) return <p className="sm-muted">This server has no other sign-in methods set up.</p>;
  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (failure) {
      const errors = fieldErrors(failure);
      setError(errors.provider ?? errors._ ?? Object.values(errors)[0] ?? "Something went wrong.");
    }
  };
  const rows = [...providers.map(p => ({ id: p.id, name: p.name, kind: p.kind })), ...linked.filter(l => !providers.some(p => p.id === l.provider)).map(l => ({ id: l.provider, name: l.name, kind: "oidc" as const }))];
  return (
    <>
      <p className="acct-subtitle">Log in to Vokko with an account you already have.{hasPassword ? "" : " Your account has no password, so keep at least one of these linked or set a password."}</p>
      {rows.map(row => {
        const link = linked.find(l => l.provider === row.id);
        return (
          <SettingsRow
            key={row.id}
            label={row.name}
            value={
              <span className="acct-provider">
                <ProviderIcon kind={row.kind} />
                {link ? `Linked${link.email ? ` as ${link.email}` : ""}` : <span className="sm-muted">Not linked</span>}
              </span>
            }
          >
            {link ? (
              <button type="button" className="sm-btn danger" onClick={() => void act(async () => { await request<void>("DELETE", `/users/@me/oauth/${encodeURIComponent(row.id)}`); await load(); })}>
                Unlink
              </button>
            ) : (
              <button
                type="button"
                className="sm-btn primary"
                onClick={() => (needsConfirm ? setLinking(row) : void act(() => startOAuth(row.id, true)))}
              >
                Link
              </button>
            )}
          </SettingsRow>
        );
      })}
      {error && <p className="field-error" role="alert">{error}</p>}
      {linking && <LinkDialog provider={linking} onClose={() => setLinking(null)} />}
    </>
  );
}
