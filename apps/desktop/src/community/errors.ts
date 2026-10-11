import { ApiRequestError } from "./shell";

/** Human text of a failed request: the first field message of a 50035 body, else the API message. */
export function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const field = error.api.errors && Object.values(error.api.errors)[0];
    const detail = field && typeof field === "object" && "message" in field ? String((field as { message: unknown }).message) : null;
    return detail ?? error.message;
  }
  return "Something went wrong. Try again.";
}
