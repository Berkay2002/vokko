// Sign in with GitHub / Google / OpenID Connect: starts the server's authorization flow and redeems its result.
// The client keeps a random verifier and sends only its SHA-256 (client_challenge), so a result code that leaks
// (browser history, another app claiming vokko://) cannot be redeemed anywhere else.

import { request } from "../api/rest";
import { isDesktop, onDeepLink } from "../desktop";
import type { AuthProvider, OAuthAuthorizeRequest, OAuthCompleteResponse } from "../api/types";

const KEY = "vokko.oauth";

interface Pending {
  verifier: string;
  provider: string;
  link: boolean;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function challengeOf(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function remember(pending: Pending): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(pending));
  } catch {
    /* storage blocked: the callback page will say the sign-in expired */
  }
}

function takePending(): Pending | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    return null;
  }
}

export function fetchProviders(): Promise<AuthProvider[]> {
  return request<AuthProvider[]>("GET", "/auth/providers");
}

/** Same-origin paths (the mock's consent shortcut) stay in the SPA; anything else is the provider's page. */
function go(url: string): void {
  if (url.startsWith("/")) {
    window.history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  } else if (isDesktop()) {
    // the system browser; the result comes back as vokko://auth/callback
    window.open(url, "_blank", "noopener");
  } else {
    window.location.assign(url);
  }
}

/** Sends the user to the provider. `link` connects it to the signed-in account instead of signing in; accounts with a
 *  password or two-factor confirm a new link with `confirm`. */
export async function startOAuth(provider: string, link = false, confirm: { password?: string; code?: string } = {}): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const body: OAuthAuthorizeRequest = { target: isDesktop() ? "desktop" : "web", client_challenge: await challengeOf(verifier), link, ...(link ? confirm : {}) };
  const { url } = await request<{ url: string }>("POST", `/auth/oauth/${encodeURIComponent(provider)}/authorize`, body);
  remember({ verifier, provider, link });
  go(url);
}

/** Redeems the result code from the callback. Throws when this browser did not start the flow. */
export async function completeOAuth(code: string): Promise<OAuthCompleteResponse> {
  const pending = takePending();
  if (!pending) throw new Error("This sign-in was started somewhere else or has expired. Try again.");
  return request<OAuthCompleteResponse>("POST", "/auth/oauth/complete", { code, client_verifier: pending.verifier });
}

let listening = false;

/** Desktop: `vokko://auth/callback?code=…` (or `?error=…`) from the system browser opens the callback page in the app. */
export function listenForOAuthLinks(): void {
  if (listening) return;
  listening = true;
  onDeepLink(
    link => {
      if (link.kind !== "auth") return;
      const query = link.url.includes("?") ? link.url.slice(link.url.indexOf("?") + 1) : "";
      go(`/oauth/callback#${query}`);
    },
    { kinds: ["auth"] },
  );
}
