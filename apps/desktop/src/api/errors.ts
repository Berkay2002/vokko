import type { ApiError } from "./types";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly api: ApiError;
  constructor(status: number, api: ApiError) {
    super(api.message);
    this.name = "ApiRequestError";
    this.status = status;
    this.api = api;
  }
  /** Discord-like numeric error code from the body (0 when the server sent none). */
  get code(): number {
    return this.api.code;
  }
}

/** 429: the server asks the client to wait. GETs are retried once by rest.ts; sends surface this so the UI can show a countdown. */
export class RateLimitedError extends ApiRequestError {
  /** Seconds to wait (float). */
  readonly retryAfter: number;
  readonly global: boolean;
  constructor(retryAfter: number, global: boolean, message = "You are being rate limited.", code = 0) {
    super(429, { code, message });
    this.name = "RateLimitedError";
    this.retryAfter = retryAfter;
    this.global = global;
  }
}

/** 429 code: the wait is the channel's slowmode (`retryAfter` is what is left of it). */
export const SLOWMODE_CODE = 20016;

/** 403 code: the recipient does not accept DMs from you (opening a DM or sending in a 1:1 DM). */
export const CANNOT_DM_USER = 50007;

/** Why a DM was refused. */
export const DM_REFUSED_REASON = "They only accept direct messages from friends or from people in a server they share with you.";

/** Shown on a pending message whose send was refused with CANNOT_DM_USER. */
export const DM_NOT_DELIVERED_TEXT = `Message not delivered. ${DM_REFUSED_REASON}`;

export const isDmRefused = (e: unknown): e is ApiRequestError => e instanceof ApiRequestError && e.status === 403 && e.code === CANNOT_DM_USER;