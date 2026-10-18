// Sign-up checks run before the request, so every field's problem shows at once. Copies of the server's rules (account/rules.rs);
// the server still has the final word (taken names, its own limits).
import { passwordProblem } from "./password";
import { usernameProblem } from "./useUsernameCheck";

const REQUIRED = "Required.";

/** Same shape check as the server: one @ with text on both sides, no spaces, at most 254 characters. */
export function emailProblem(raw: string): string | null {
  const email = raw.trim();
  const [local, domain, extra] = email.split("@");
  return email.length <= 254 && !/\s/.test(email) && local && domain && extra === undefined ? null : "Not a well formed email address.";
}

export interface RegisterForm {
  email: string;
  username: string;
  password: string;
  /** ISO date, or null when the picker is incomplete. */
  dateOfBirth: string | null;
  /** Null when the server has no terms to agree to. */
  consent: boolean | null;
}

/** Field errors keyed like the server's 50035 response; empty when the form can be sent. */
export function registerProblems(form: RegisterForm): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (field: string, problem: string | null) => {
    if (problem) out[field] = problem;
  };
  set("email", form.email.trim() ? emailProblem(form.email) : REQUIRED);
  set("username", form.username.trim() ? usernameProblem(form.username) : REQUIRED);
  set("password", form.password ? passwordProblem(form.password, [form.username, form.email]) : REQUIRED);
  set("date_of_birth", form.dateOfBirth ? null : REQUIRED);
  set("consent", form.consent === false ? "You need to agree to the terms." : null);
  return out;
}
