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
