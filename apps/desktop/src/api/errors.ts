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
  constructor(retryAfter: number, global: boolean, message = "You are being rate limited.") {
    super(429, { code: 0, message });
    this.name = "RateLimitedError";
    this.retryAfter = retryAfter;
    this.global = global;
  }
}
