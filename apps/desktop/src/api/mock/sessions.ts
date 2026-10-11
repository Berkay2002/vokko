// Mock session tokens. `mock:<user id>` (the `?as=` shortcut and old tokens) always works; logins issue
// `mock:<user id>:<n>` tokens that are listed in Devices and can be revoked like the real server's.

import { db } from "./db";

export interface MockSession {
  token: string;
  userId: string;
  os: string | null;
  platform: string | null;
  lastUsed: number;
}

export const sessions = new Map<string, MockSession>();
const revoked = new Set<string>();
let counter = 0;
/** Token of the request being handled (set by mockRequest). */
let current: string | null = null;

export function setCurrentToken(token: string | null): void {
  current = token;
}

export function currentToken(): string | null {
  return current;
}

function clientInfo(): { os: string | null; platform: string | null } {
  if (typeof navigator === "undefined") return { os: null, platform: null };
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : null;
  const platform = /Tauri/.test(ua) ? "Vokko Desktop" : /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  return { os, platform };
}

export function issueToken(userId: string): string {
  counter += 1;
  const token = `mock:${userId}:${counter}`;
  sessions.set(token, { token, userId, ...clientInfo(), lastUsed: Date.now() });
  return token;
}

export function tokenUserId(token: string | null): string | null {
  if (!token?.startsWith("mock:") || revoked.has(token)) return null;
  const id = token.slice(5).split(":")[0] ?? "";
  if (!db.accounts.has(id)) return null;
  const session = sessions.get(token);
  if (session) session.lastUsed = Date.now();
  return id;
}

export function revokeToken(token: string): void {
  revoked.add(token);
  sessions.delete(token);
}

/** Revokes the user's issued tokens (all, or all but `keep`). The bare `mock:<id>` token is revoked too unless kept. */
export function revokeUser(userId: string, keep: string | null = null): void {
  for (const session of [...sessions.values()]) if (session.userId === userId && session.token !== keep) revokeToken(session.token);
  const bare = `mock:${userId}`;
  if (keep !== bare) revoked.add(bare);
}

/** A bare token was revoked but the user signs in again: let `?as=` style tokens work after a fresh login. */
export function unrevokeBare(userId: string): void {
  revoked.delete(`mock:${userId}`);
}
