import { useEffect, useState } from "react";
import { ApiRequestError } from "../api/errors";
import { usernameAttempt } from "./api";

export type UsernameStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available" }
  | { state: "taken" }
  | { state: "invalid"; message: string };

/** Client-side copy of the server's username rules (account/rules.rs). */
export function usernameProblem(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  if (name.length < 2 || name.length > 32 || !/^[a-z0-9_.]+$/.test(name)) return "Must be 2-32 characters: lowercase letters, numbers, '_' and '.'.";
  if (name.includes("..")) return "Can't contain two dots in a row.";
  return null;
}

/** Live availability of `username` (debounced). `unchanged` is the user's current name, which needs no check. */
export function useUsernameCheck(username: string, unchanged?: string): UsernameStatus {
  const [status, setStatus] = useState<UsernameStatus>({ state: "idle" });
  useEffect(() => {
    const name = username.trim().toLowerCase();
    if (!name || name === unchanged) {
      setStatus({ state: "idle" });
      return;
    }
    const problem = usernameProblem(name);
    if (problem) {
      setStatus({ state: "invalid", message: problem });
      return;
    }
    setStatus({ state: "checking" });
    let cancelled = false;
    const timer = setTimeout(() => {
      usernameAttempt(name).then(
        result => !cancelled && setStatus({ state: result.taken ? "taken" : "available" }),
        // rate limited or offline: no verdict, the submit will tell
        (error: unknown) => {
          if (cancelled) return;
          const message = error instanceof ApiRequestError && error.status === 400 ? error.api.errors : null;
          const text = (message as { username?: { _errors?: { message?: string }[]; message?: string } } | null)?.username;
          setStatus(text ? { state: "invalid", message: text._errors?.[0]?.message ?? text.message ?? "Invalid username." } : { state: "idle" });
        },
      );
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [username, unchanged]);
  return status;
}

export function UsernameHint({ status }: { status: UsernameStatus }) {
  switch (status.state) {
    case "available":
      return <p className="auth-hint positive" role="status">Username is available. Nice!</p>;
    case "taken":
      return <p className="auth-hint critical" role="status">Username is unavailable. Try adding numbers, letters, underscores _ , or periods.</p>;
    case "invalid":
      return <p className="auth-hint critical" role="status">{status.message}</p>;
    case "checking":
      return <p className="auth-hint" role="status">Checking...</p>;
    default:
      return <p className="auth-hint">Please only use numbers, letters, underscores _ , or periods.</p>;
  }
}
