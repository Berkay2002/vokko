import { useEffect, useState } from "react";
import type { AuthProvider } from "../api/types";
import { fetchProviders, startOAuth } from "./oauth";
import { ProviderIcon } from "./ProviderIcon";
import { fieldErrors } from "./ui";

/** "Continue with ..." buttons for the providers this instance has configured; nothing when there are none. */
export function OAuthButtons() {
  const [providers, setProviders] = useState<AuthProvider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    fetchProviders().then(setProviders, () => setProviders([]));
  }, []);
  if (providers.length === 0) return null;
  const start = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await startOAuth(id);
    } catch (failure) {
      setError(fieldErrors(failure)._ ?? Object.values(fieldErrors(failure))[0] ?? "Could not start the sign-in.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="auth-providers">
      <div className="auth-divider">
        <span>or</span>
      </div>
      {providers.map(provider => (
        <button key={provider.id} type="button" className="btn btn-secondary btn-wide auth-provider" disabled={busy !== null} onClick={() => void start(provider.id)}>
          <ProviderIcon kind={provider.kind} />
          Continue with {provider.name}
        </button>
      ))}
      {error && <p className="auth-error" role="alert">{error}</p>}
    </div>
  );
}
