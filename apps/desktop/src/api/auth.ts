// Session lifecycle: token persistence, login/register/logout and bootstrap.

import { MOCK, getToken, setToken } from "./config";
import { gateway } from "./gateway";
import { request, setUnauthorizedHandler } from "./rest";
import { appStore, wireStoreToGateway } from "./store";
import type { AuthResponse, LoginResponse, MfaRequiredResponse, RegisterRequest } from "./types";

function startSession(token: string): void {
  setToken(token);
  appStore.setState({ token });
  gateway.connect(token);
}

/** Drop the local session (token, gateway, store). Idempotent. */
export function clearSession(): void {
  setToken(null);
  gateway.disconnect();
  appStore.getState().reset();
}

/** Signs in with a login response: a session starts, or the two-factor step is returned for the caller to finish. */
export function acceptLogin(response: LoginResponse): MfaRequiredResponse | null {
  if (response.token === null) return response;
  appStore.getState().cacheUsers([response.user]);
  startSession(response.token);
  return null;
}

/** Resolves to the two-factor step when the account has it on (finish with `mfaLogin`), otherwise to null once signed in. */
export async function login(loginName: string, password: string): Promise<MfaRequiredResponse | null> {
  return acceptLogin(await request<LoginResponse>("POST", "/auth/login", { login: loginName, password }));
}

export async function mfaLogin(ticket: string, code: string): Promise<void> {
  acceptLogin(await request<AuthResponse>("POST", "/auth/mfa/totp", { ticket, code }));
}

export async function register(input: RegisterRequest): Promise<void> {
  const response = await request<AuthResponse>("POST", "/auth/register", input);
  appStore.getState().cacheUsers([response.user]);
  startSession(response.token);
}

export async function logout(): Promise<void> {
  try {
    await request<void>("POST", "/auth/logout");
  } catch {
    /* the local session is dropped regardless */
  }
  clearSession();
}

let booted = false;

/** Call once at startup: restores a stored token (or `?as=<username>` in mock mode) and connects the gateway. */
export function bootstrap(): void {
  if (booted) return;
  booted = true;
  wireStoreToGateway();
  setUnauthorizedHandler(clearSession);
  gateway.onAuthFailed(clearSession);
  if (MOCK) {
    const as = new URLSearchParams(window.location.search).get("as");
    if (as) setToken(`mock:${userIdForUsername(as)}`);
  }
  const token = getToken();
  if (token) startSession(token);
}

/** Mock-only: `?as=alice` signs in as a seed user without the login form (used by screenshots and tests). */
function userIdForUsername(username: string): string {
  const hooks = (window as unknown as { __vokkoMock?: { tokenFor(name: string): string | null } }).__vokkoMock;
  return hooks?.tokenFor(username)?.slice(5) ?? "";
}
