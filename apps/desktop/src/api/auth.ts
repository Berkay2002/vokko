// Session lifecycle: token persistence, login/register/logout and bootstrap.

import { MOCK, getToken, setToken } from "./config";
import { gateway } from "./gateway";
import { request, setUnauthorizedHandler } from "./rest";
import { appStore, wireStoreToGateway } from "./store";
import type { AuthResponse, RegisterRequest } from "./types";

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

export async function login(loginName: string, password: string): Promise<void> {
  const response = await request<AuthResponse>("POST", "/auth/login", { login: loginName, password });
  appStore.getState().cacheUsers([response.user]);
  startSession(response.token);
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
