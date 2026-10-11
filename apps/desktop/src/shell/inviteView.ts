// What /invite/:code shows: the preview request's outcome (and who is asking) decides the screen.

import { ApiRequestError, RateLimitedError } from "../api/errors";
import type { Invite } from "../api/types";

export type InviteLoad =
  | { status: "loading" }
  | { status: "ok"; invite: Invite }
  /** The server wants an account even to preview an invite (401). */
  | { status: "locked" }
  /** 404: expired, used up, revoked or never existed. */
  | { status: "invalid" }
  /** Anything else (rate limit, server or network trouble): the invite may still be fine. */
  | { status: "failed"; message: string };

/** Error text for the screen: the server's own message, with the wait when it asked for one. */
export function errorText(error: unknown, fallback: string): string {
  if (error instanceof RateLimitedError) return `${error.message} Try again in ${Math.max(1, Math.ceil(error.retryAfter))}s.`;
  return error instanceof ApiRequestError ? error.message : fallback;
}

export function loadFailed(error: unknown): InviteLoad {
  if (error instanceof ApiRequestError && error.status === 401) return { status: "locked" };
  if (error instanceof ApiRequestError && error.status === 404) return { status: "invalid" };
  return { status: "failed", message: errorText(error, "Could not reach the server.") };
}

/** A signed-in visitor waits for READY before the card, so "already in this server" is known when it appears. */
export function shownLoad(load: InviteLoad, signedIn: boolean, ready: boolean): InviteLoad {
  return load.status === "ok" && signedIn && !ready ? { status: "loading" } : load;
}
