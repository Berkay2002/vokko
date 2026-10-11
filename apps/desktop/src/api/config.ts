// Backend selection. One place derives every URL so the server team's routes only need a change here.

const origin = (import.meta.env.VITE_VOKKO_API ?? "").trim().replace(/\/+$/, "");

/** True when no server is configured: REST and the gateway are served by the in-memory mock. */
export const MOCK = origin === "";
export const API_ORIGIN = origin;
export const REST_BASE = `${origin}/api/v1`;
export const GATEWAY_URL = import.meta.env.VITE_VOKKO_GATEWAY?.trim() || `${origin.replace(/^http/, "ws")}/gateway`;

const TOKEN_KEY = "vokko.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: session only */
  }
}
