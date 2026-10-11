import { KeyRound } from "lucide-react";
import { siGithub, siGoogle } from "simple-icons";
import type { AuthProvider } from "../api/types";

/** Monochrome provider marks from simple-icons (CC0), unmodified; generic OIDC providers get a lucide key. */
export function ProviderIcon({ kind }: { kind: AuthProvider["kind"] }) {
  const icon = kind === "github" ? siGithub : kind === "google" ? siGoogle : null;
  if (!icon) return <KeyRound size={20} aria-hidden="true" />;
  return (
    <svg className="auth-provider-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={icon.path} />
    </svg>
  );
}
