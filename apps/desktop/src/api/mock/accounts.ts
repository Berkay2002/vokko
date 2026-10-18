// Mock of the account routes (docs/api.md "Accounts"): registration rules, username check, email verification.
// Registered by import side effect from index.ts. Account-only state lives in `accountState`, keyed by user id.

import type { AccountInfo, AuthProvider, BackupCode, InstanceInfo, LinkedProvider, LoginResponse, OAuthRegistration, UserSession } from "../types";
import { db, nextId, type MockAccount } from "./db";
import { createAccount, fail } from "./ops";
import { route, str } from "./router";
import { currentToken, issueToken, revokeToken, revokeUser, sessions, tokenUserId, unrevokeBare } from "./sessions";
import { matchingStep } from "./totp";
import { emit } from "./socket";

export interface AccountState {
  date_of_birth: string | null;
  email_verified: boolean;
  pending_email: string | null;
  has_password: boolean;
  disabled: boolean;
  deleted: boolean;
  mfa_secret: string | null;
  mfa_last_step: number;
  /** when the current address was verified (ms) */
  verified_at: number | null;
  backup_codes: { code: string; consumed: boolean }[];
}

const states = new Map<string, AccountState>();

export function accountState(userId: string): AccountState {
  let state = states.get(userId);
  if (!state) states.set(userId, (state = { date_of_birth: null, email_verified: true, pending_email: null, has_password: true, disabled: false, deleted: false, mfa_secret: null, mfa_last_step: 0, backup_codes: [], verified_at: 0 }));
  return state;
}

/** Instance settings; tests change them through `__vokkoMockAccounts.instance()`. */
export const instance: InstanceInfo = { registration: "open", min_age: 13, terms: null, terms_url: null, email_verification: true };

export interface MockMail {
  to: string;
  subject: string;
  body: string;
}

/** Mails "sent" by the mock (the real server logs them when SMTP is not configured). */
export const outbox: MockMail[] = [];
/** token → what it does */
const emailTokens = new Map<string, { userId: string; purpose: "verify" | "reset"; email: string }>();

export function mailLink(userId: string, purpose: "verify" | "reset", email: string): void {
  for (const [token, entry] of emailTokens) if (entry.userId === userId && entry.purpose === purpose) emailTokens.delete(token);
  const token = `${nextId()}${Math.random().toString(16).slice(2)}`;
  emailTokens.set(token, { userId, purpose, email });
  const subject = purpose === "verify" ? "Verify your email address" : "Reset your password";
  outbox.push({ to: email, subject, body: `${window.location.origin}/${purpose}#token=${token}` });
}

export function emailTokensView(): Iterable<[string, { userId: string; purpose: "verify" | "reset"; email: string }]> {
  return emailTokens.entries();
}

export function consumeEmailToken(token: string, purpose: "verify" | "reset"): { userId: string; email: string } | null {
  const entry = emailTokens.get(token);
  if (!entry || entry.purpose !== purpose) return null;
  emailTokens.delete(token);
  return entry;
}

export const invalid = (field: string, message: string): never => fail(400, 50035, "Invalid Form Body", { [field]: { _errors: [{ code: "INVALID", message }] } });

const COMMON = new Set(["password", "password1", "password123", "12345678", "123456789", "qwerty123", "11111111", "iloveyou", "passw0rd", "abcd1234", "changeme"]);

export function checkUsername(raw: unknown): string {
  const username = (str(raw) ?? "").trim().toLowerCase();
  if (username.length < 2 || username.length > 32 || !/^[a-z0-9_.]+$/.test(username)) invalid("username", "Must be 2-32 characters: lowercase letters, numbers, '_' and '.'.");
  if (username.includes("..")) invalid("username", "Can't contain two dots in a row.");
  return username;
}

export function usernameTaken(username: string): boolean {
  return [...db.accounts.values()].some(a => a.user.username === username);
}

export function checkPassword(raw: unknown, personal: string[], field = "password"): string {
  const password = str(raw) ?? "";
  if (password.length < 8 || password.length > 128) invalid(field, "Must be between 8 and 128 in length.");
  const lower = password.toLowerCase();
  const hit = personal.map(p => p.split("@")[0] ?? "").some(p => p.length >= 3 && lower.includes(p));
  if (COMMON.has(lower) || new Set(lower).size < 4 || hit) invalid(field, "Password is too weak or common to use.");
  return password;
}

export function checkEmail(raw: unknown): string {
  const email = (str(raw) ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) invalid("email", "Not a well formed email address.");
  return email;
}

export function checkDateOfBirth(raw: unknown): string {
  const value = str(raw) ?? "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!value) invalid("date_of_birth", "Required.");
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!match || !date || date.getUTCDate() !== Number(match[3]) || date.getTime() > Date.now()) invalid("date_of_birth", "Not a valid date.");
  const now = new Date();
  let age = now.getUTCFullYear() - Number(match![1]);
  if (now.getUTCMonth() + 1 < Number(match![2]) || (now.getUTCMonth() + 1 === Number(match![2]) && now.getUTCDate() < Number(match![3]))) age -= 1;
  if (age < instance.min_age) invalid("date_of_birth", `You need to be ${instance.min_age} or older to use Vokko.`);
  return value;
}

route("GET", "/auth/instance", () => ({ ...instance }));

route("POST", "/auth/username-attempt", ({ body }) => ({ taken: usernameTaken(checkUsername(body.username)) }));

route("POST", "/auth/register", ({ body }) => {
  if (instance.registration === "closed") fail(403, 40002, "Registration is closed on this server");
  const email = checkEmail(body.email);
  const username = checkUsername(body.username);
  const globalName = str(body.global_name)?.trim() ?? "";
  if (globalName.length > 32) invalid("global_name", "Must be 32 or fewer in length.");
  const password = checkPassword(body.password, [username, email]);
  const dob = checkDateOfBirth(body.date_of_birth);
  if (instance.terms && body.consent !== true) invalid("consent", "You need to agree to the terms.");
  if (usernameTaken(username)) invalid("username", "Already taken.");
  if ([...db.accounts.values()].some(a => a.email.toLowerCase() === email)) invalid("email", "Already taken.");
  const account = createAccount({ username, email, password, global_name: globalName || null });
  Object.assign(accountState(account.user.id), { date_of_birth: dob, email_verified: false, verified_at: null });
  mailLink(account.user.id, "verify", email);
  return { token: issueToken(account.user.id), user: account.user };
});

route("POST", "/auth/verify", ({ body }) => {
  const entry = consumeEmailToken(str(body.token) ?? "", "verify");
  const account = entry && db.accounts.get(entry.userId);
  if (!entry || !account) return invalid("token", "This link is invalid or has expired.");
  const state = accountState(account.user.id);
  if (account.email !== entry.email && state.pending_email !== entry.email) invalid("token", "This link is invalid or has expired.");
  if (account.email !== entry.email && [...db.accounts.values()].some(a => a.email === entry.email)) invalid("email", "Already taken.");
  account.email = entry.email;
  state.pending_email = null;
  state.email_verified = true;
  // like the server: the first verification is remembered; verifying never removes sign-in methods
  state.verified_at ??= Date.now();
  return undefined;
});

route("POST", "/auth/verify/resend", ({ viewer }) => {
  if (!viewer) fail(401, 0, "401: Unauthorized");
  const state = accountState(viewer.user.id);
  if (state.pending_email) mailLink(viewer.user.id, "verify", state.pending_email);
  else if (!state.email_verified) mailLink(viewer.user.id, "verify", viewer.email);
  else invalid("email", "Your email is already verified.");
  return undefined;
});

const requireViewer = (viewer: MockAccount | undefined): MockAccount => viewer ?? fail(401, 0, "401: Unauthorized");

export function loginFail(): never {
  return fail(400, 50035, "Invalid Form Body", { login: { _errors: [{ code: "INVALID_LOGIN", message: "Login or password is invalid." }] } });
}

/** Account matching a login name and password (deleted accounts never match). */
export function passwordLogin(login: string, password: string): MockAccount {
  const name = login.trim().toLowerCase();
  const account = [...db.accounts.values()].find(a => !accountState(a.user.id).deleted && (a.user.username === name || a.email.toLowerCase() === name));
  if (!account || !accountState(account.user.id).has_password || account.password !== password) return loginFail();
  return account;
}

const tickets = new Map<string, { userId: string; attempts: number; expires: number }>();

/** The end of every sign-in: the two-factor step when it is on, otherwise a session. */
export function finishLogin(account: MockAccount): LoginResponse {
  if (accountState(account.user.id).mfa_secret) {
    const ticket = `ticket:${nextId()}`;
    tickets.set(ticket, { userId: account.user.id, attempts: 0, expires: Date.now() + 5 * 60_000 });
    return { token: null, mfa: true, ticket, totp: true, backup: true };
  }
  return signIn(account);
}

/** A TOTP code (never the same step twice) or an unused backup code. */
const failures = new Map<string, number[]>();

/** Like the server: 10 wrong codes per account in 15 minutes, then 429. */
export function checkCode(userId: string, raw: unknown): boolean {
  const recent = (failures.get(userId) ?? []).filter(at => Date.now() - at < 15 * 60_000);
  if (recent.length >= 10) fail(429, 0, "Too many wrong codes. Try again in 15 minutes.");
  const ok = checkCodeOnce(userId, raw);
  if (!ok) failures.set(userId, [...recent, Date.now()]);
  return ok;
}

function checkCodeOnce(userId: string, raw: unknown): boolean {
  const state = accountState(userId);
  const code = (str(raw) ?? "").replace(/[\s-]/g, "").toLowerCase();
  if (!state.mfa_secret) return false;
  if (/^\d{6}$/.test(code)) {
    const step = matchingStep(state.mfa_secret, code);
    if (step === null || step <= state.mfa_last_step) return false;
    state.mfa_last_step = step;
    return true;
  }
  const backup = state.backup_codes.find(b => b.code === code && !b.consumed);
  if (!backup) return false;
  backup.consumed = true;
  return true;
}

const invalidCode = (): never => invalid("code", "Invalid two-factor code");

export function requireCode(userId: string, code: unknown): void {
  if (accountState(userId).mfa_secret && !checkCode(userId, code)) invalidCode();
}

function newBackupCodes(userId: string): BackupCode[] {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const codes = Array.from({ length: 10 }, () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => alphabet[b % alphabet.length]).join(""));
  accountState(userId).backup_codes = codes.map(code => ({ code, consumed: false }));
  return codes.map(code => ({ code, consumed: false }));
}

/** Signs the account in: re-enables a disabled account and issues a token. */
export function signIn(account: MockAccount): { token: string; user: MockAccount["user"] } {
  accountState(account.user.id).disabled = false;
  unrevokeBare(account.user.id);
  return { token: issueToken(account.user.id), user: account.user };
}

route("POST", "/auth/login", ({ body }) => finishLogin(passwordLogin(str(body.login) ?? "", str(body.password) ?? "")));

route("POST", "/auth/mfa/totp", ({ body }) => {
  const ticket = tickets.get(str(body.ticket) ?? "");
  if (!ticket || ticket.expires < Date.now() || ticket.attempts >= 5) return invalid("ticket", "This login has expired. Log in again.");
  ticket.attempts += 1;
  if (!checkCode(ticket.userId, body.code)) return invalidCode();
  tickets.delete(str(body.ticket) ?? "");
  return signIn(db.accounts.get(ticket.userId)!);
});

route("POST", "/auth/forgot", ({ body }) => {
  const name = (str(body.login) ?? "").trim().toLowerCase();
  const account = [...db.accounts.values()].find(a => !accountState(a.user.id).deleted && (a.user.username === name || a.email.toLowerCase() === name));
  if (account) mailLink(account.user.id, "reset", account.email);
  return undefined;
});

route("POST", "/auth/reset", ({ body }) => {
  const token = str(body.token) ?? "";
  const peek = [...emailTokensView()].find(([t, entry]) => t === token && entry.purpose === "reset");
  const account = peek && db.accounts.get(peek[1].userId);
  if (!account) return invalid("token", "This link is invalid or has expired.");
  const password = checkPassword(body.password, [account.user.username, account.email]);
  consumeEmailToken(token, "reset");
  account.password = password;
  const before = accountState(account.user.id);
  // links made before the address was proven go (all of them if it never was)
  const provenAt = before.email_verified ? before.verified_at : null;
  for (const [key, entry] of [...identities]) if (entry.userId === account.user.id && (provenAt === null || Date.parse(entry.linkedAt) < provenAt)) identities.delete(key);
  Object.assign(before, { has_password: true, email_verified: true, pending_email: null, verified_at: before.email_verified ? before.verified_at : Date.now() });
  for (const [t, entry] of [...emailTokens]) if (entry.userId === account.user.id && entry.purpose === "verify") emailTokens.delete(t);
  revokeUser(account.user.id);
  return finishLogin(account);
});

route("GET", "/auth/sessions", ({ viewer }) => {
  const account = requireViewer(viewer);
  const current = currentToken();
  const user_sessions: UserSession[] = [...sessions.values()]
    .filter(session => session.userId === account.user.id)
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .map(session => ({ id_hash: session.token.replace(/\W/g, ""), approx_last_used_time: new Date(session.lastUsed).toISOString(), client_info: { os: session.os, platform: session.platform }, current: session.token === current }));
  return { user_sessions };
});

route("POST", "/auth/sessions/logout", ({ viewer, body }) => {
  const account = requireViewer(viewer);
  const wanted = new Set(Array.isArray(body.session_id_hashes) ? body.session_id_hashes : []);
  for (const session of [...sessions.values()]) if (session.userId === account.user.id && wanted.has(session.token.replace(/\W/g, ""))) revokeToken(session.token);
  return undefined;
});

route("POST", "/users/@me/mfa/totp/enable", ({ viewer, body }) => {
  const account = requireViewer(viewer);
  const state = accountState(account.user.id);
  if (state.mfa_secret) invalid("code", "Two-factor authentication is already enabled.");
  if (!state.email_verified) invalid("email", "Verify your email address before turning on two-factor authentication.");
  confirmIdentity(account, body);
  const secret = (str(body.secret) ?? "").replace(/[\s=]/g, "").toUpperCase();
  if (secret.length < 16 || !/^[A-Z2-7]+$/.test(secret)) invalid("secret", "Not a valid base32 secret of at least 16 characters.");
  const step = matchingStep(secret, (str(body.code) ?? "").trim());
  if (step === null) return invalidCode();
  Object.assign(state, { mfa_secret: secret, mfa_last_step: step });
  return { backup_codes: newBackupCodes(account.user.id) };
});

route("POST", "/users/@me/mfa/totp/disable", ({ viewer, body }) => {
  const account = requireViewer(viewer);
  if (!checkCode(account.user.id, body.code)) invalidCode();
  Object.assign(accountState(account.user.id), { mfa_secret: null, mfa_last_step: 0, backup_codes: [], verified_at: 0 });
  return undefined;
});

route("POST", "/users/@me/mfa/codes-verification", ({ viewer, body }) => {
  const account = requireViewer(viewer);
  const state = accountState(account.user.id);
  if (!state.mfa_secret) invalid("code", "Two-factor authentication is not enabled.");
  confirmIdentity(account, body);
  if (body.regenerate === true) return { backup_codes: newBackupCodes(account.user.id) };
  return { backup_codes: state.backup_codes.map(b => ({ code: null, consumed: b.consumed })) };
});

route("POST", "/auth/logout", () => {
  const token = currentToken();
  if (token) revokeToken(token);
  return undefined;
});

export function accountInfo(account: MockAccount): AccountInfo {
  const state = accountState(account.user.id);
  return { email: account.email, pending_email: state.pending_email, verified: state.email_verified, has_password: state.has_password, mfa_enabled: state.mfa_secret !== null };
}

export function confirmPassword(account: MockAccount, password: unknown): void {
  if (!accountState(account.user.id).has_password) return;
  if (typeof password !== "string" || password !== account.password) invalid("password", "Password does not match.");
}

/** token → when it last signed in or re-confirmed through a provider */
const freshAt = new Map<string, number>();

function markFresh(token: string | null): void {
  if (token) freshAt.set(token, Date.now());
}

/** Like the server's confirm_identity: password, else a code with two-factor on, else a fresh provider sign-in. */
export function confirmIdentity(account: MockAccount, body: Record<string, unknown>, alsoCode = false): void {
  const state = accountState(account.user.id);
  if (state.has_password) {
    confirmPassword(account, body.password);
    if (alsoCode) requireCode(account.user.id, body.code);
    return;
  }
  if (state.mfa_secret) return requireCode(account.user.id, body.code);
  const token = currentToken();
  if (!token || Date.now() - (freshAt.get(token) ?? 0) > 5 * 60_000) invalid("reauth", "Confirm it's you: sign in again with a linked provider, then retry.");
}

export function audienceOf(userId: string): Set<string> {
  const viewer = db.accounts.get(userId);
  const audience = new Set<string>([userId, ...(viewer?.relationships.keys() ?? [])]);
  for (const guild of db.guilds.values()) if (guild.members.has(userId)) for (const id of guild.members.keys()) audience.add(id);
  for (const channel of db.channels.values()) if (channel.participant_ids?.includes(userId)) for (const id of channel.participant_ids) audience.add(id);
  return audience;
}

route("GET", "/users/@me/account", ({ viewer }) => accountInfo(requireViewer(viewer)));

route("PATCH", "/users/@me/account", ({ viewer, body }) => {
  const account = requireViewer(viewer);
  const state = accountState(account.user.id);
  const username = body.username === undefined ? null : checkUsername(body.username);
  const email = body.email === undefined ? null : checkEmail(body.email);
  const changeName = username !== null && username !== account.user.username;
  const changeEmail = email !== null && email !== account.email;
  const newPassword = body.new_password === undefined ? null : checkPassword(body.new_password, [username ?? account.user.username, account.email], "new_password");
  if (!changeName && !changeEmail && newPassword === null) return { user: account.user, account: accountInfo(account) };
  confirmIdentity(account, body);
  if (changeEmail && [...db.accounts.values()].some(a => a !== account && a.email === email)) invalid("email", "Already taken.");
  if (changeName && usernameTaken(username!)) invalid("username", "Already taken.");
  if (changeName) account.user.username = username!;
  if (changeEmail) {
    state.pending_email = email;
    mailLink(account.user.id, "verify", email!);
    outbox.push({ to: account.email, subject: "Your Vokko email is changing", body: `Your email is changing to ${email}.` });
  }
  if (newPassword !== null) {
    account.password = newPassword;
    state.has_password = true;
    // like the server: a password rotation cancels an email change started in an earlier request
    if (!changeEmail) {
      state.pending_email = null;
      for (const [token, entry] of [...emailTokens]) if (entry.userId === account.user.id && entry.purpose === "verify" && entry.email !== account.email) emailTokens.delete(token);
    }
    revokeUser(account.user.id, currentToken());
  }
  if (changeName) emit(audienceOf(account.user.id), "USER_UPDATE", { ...account.user });
  return { user: account.user, account: accountInfo(account) };
});

route("POST", "/users/@me/disable", ({ viewer, body }) => {
  const account = requireViewer(viewer);
  confirmIdentity(account, body, true);
  accountState(account.user.id).disabled = true;
  revokeUser(account.user.id);
  return undefined;
});

route("POST", "/users/@me/delete", ({ viewer, body }) => {
  const account = requireViewer(viewer);
  const id = account.user.id;
  confirmIdentity(account, body, true);
  if ([...db.guilds.values()].some(g => g.guild.owner_id === id)) {
    fail(400, 40011, "You need to transfer ownership of the servers you own, or delete them, before deleting your account.");
  }
  const audience = audienceOf(id);
  for (const guild of db.guilds.values()) {
    if (!guild.members.delete(id)) continue;
    emit(guild.members.keys(), "GUILD_MEMBER_REMOVE", { guild_id: guild.guild.id, user: account.user });
  }
  for (const otherId of account.relationships.keys()) {
    db.accounts.get(otherId)?.relationships.delete(id);
    emit([otherId], "RELATIONSHIP_REMOVE", { id });
  }
  account.relationships.clear();
  Object.assign(account.user, { username: `deleted_user_${nextId().slice(-12)}`, global_name: "Deleted User", avatar: null, bio: null, banner_color: null, banner: null, pronouns: null, theme_colors: null, avatar_decoration: null, profile_effect: null, primary_guild: null, profile_frame: null, widgets: null });
  account.email = `deleted-${id}@deleted.invalid`;
  Object.assign(accountState(id), { deleted: true, has_password: false, pending_email: null, mfa_secret: null, backup_codes: [] });
  for (const [key, entry] of [...identities]) if (entry.userId === id) identities.delete(key);
  revokeUser(id);
  emit(audience, "USER_UPDATE", { ...account.user });
  return undefined;
});

// ---- sign in with providers (the mock provider consents at once and returns straight to /oauth/callback) ----

export const providers: AuthProvider[] = [
  { id: "github", name: "GitHub", kind: "github" },
  { id: "google", name: "Google", kind: "google" },
  { id: "gitlab", name: "GitLab", kind: "oidc" },
];

/** What each mock provider says about its user: GitHub shares no verified email, the others do. */
const mockIdentity = (provider: string) => ({
  subject: `mock-${provider}-user`,
  email: provider === "github" ? null : `octo@${provider}.example`,
  username: "octocat",
  name: "Octo Cat",
});

/** `${provider}:${subject}` → user id, plus when it was linked. */
const identities = new Map<string, { userId: string; email: string | null; linkedAt: string }>();
const results = new Map<string, { kind: "login" | "register" | "link" | "ticket"; provider: string; userId: string | null; subject: string; email: string | null; suggested: string | null; name: string | null }>();

route("GET", "/auth/providers", () => providers.map(p => ({ ...p })));

route("POST", "/auth/oauth/([a-z0-9_]+)/authorize", ({ viewer, params, body }) => {
  const provider = providers.find(p => p.id === params[0]) ?? invalid("provider", "Unknown sign-in provider.");
  if (typeof body.client_challenge !== "string" || body.client_challenge.length !== 43) invalid("client_challenge", "Must be base64url(SHA-256(client_verifier)).");
  const identity = mockIdentity(provider.id);
  const key = `${provider.id}:${identity.subject}`;
  const owner = identities.get(key)?.userId ?? null;
  let kind: "login" | "register" | "link" = owner ? "login" : "register";
  let userId = owner;
  if (body.link === true) {
    const account = requireViewer(viewer);
    const state = accountState(account.user.id);
    // like the server: password or two-factor accounts prove it is them before a link starts
    if (state.has_password || state.mfa_secret) confirmIdentity(account, body);
    if (owner && owner !== account.user.id) {
      return { url: `/oauth/callback#error=${encodeURIComponent(`This ${provider.name} account is already linked to another Vokko account.`)}` };
    }
    // linked only in /auth/oauth/complete, by the same account's session
    kind = "link";
    userId = account.user.id;
  }
  const code = `result${nextId()}`;
  const suggested = usernameTaken(identity.username) ? null : identity.username;
  results.set(code, { kind, provider: provider.id, userId, subject: identity.subject, email: identity.email, suggested, name: identity.name });
  return { url: `/oauth/callback#code=${code}&provider=${provider.id}` };
});

route("POST", "/auth/oauth/complete", ({ body }) => {
  const code = str(body.code) ?? "";
  const result = results.get(code);
  // the mock cannot hash synchronously, so it only insists that a verifier is sent
  if (!result || result.kind === "ticket" || !str(body.client_verifier)) return invalid("code", "This sign-in has expired. Try again.");
  results.delete(code);
  if (result.kind === "login") {
    const login = finishLogin(db.accounts.get(result.userId!)!);
    if (login.token !== null) markFresh(login.token);
    return { kind: "login", login };
  }
  if (result.kind === "link") {
    const token = currentToken();
    if (tokenUserId(token) !== result.userId) return invalid("code", "This link was started by another account. Start it again while signed in.");
    const key = `${result.provider}:${result.subject}`;
    if (identities.get(key)?.userId === result.userId) {
      markFresh(token);
      return { kind: "reauthenticated", provider: result.provider };
    }
    const linker = accountState(result.userId!);
    if (!linker.email_verified) return invalid("email", "Verify your email address before linking another sign-in method.");
    if (!linker.has_password && !linker.mfa_secret) confirmIdentity(db.accounts.get(result.userId!)!, {});
    identities.set(key, { userId: result.userId!, email: result.email, linkedAt: new Date().toISOString() });
    return { kind: "linked", provider: result.provider };
  }
  if (instance.registration === "closed") fail(403, 40002, "Registration is closed on this server");
  const ticket = `ticket${nextId()}`;
  results.set(ticket, { ...result, kind: "ticket" });
  const registration: OAuthRegistration = { ticket, provider: result.provider, email: result.email, suggested_username: result.suggested, global_name: result.name };
  return { kind: "register", registration };
});

route("POST", "/auth/oauth/register", ({ body }) => {
  const ticket = str(body.ticket) ?? "";
  const result = results.get(ticket);
  if (!result || result.kind !== "ticket") return invalid("ticket", "This sign-up has expired. Start again.");
  const username = checkUsername(body.username);
  const email = result.email ?? checkEmail(body.email);
  const dob = checkDateOfBirth(body.date_of_birth);
  if (instance.terms && body.consent !== true) invalid("consent", "You need to agree to the terms.");
  if (usernameTaken(username)) invalid("username", "Already taken.");
  if ([...db.accounts.values()].some(a => a.email === email)) {
    const name = providers.find(p => p.id === result.provider)?.name ?? result.provider;
    invalid("email", `An account with this email already exists. Log in to it and link ${name} under My Account > Sign-in Methods.`);
  }
  results.delete(ticket);
  const account = createAccount({ username, email, password: "", global_name: str(body.global_name)?.trim() || null });
  Object.assign(accountState(account.user.id), { date_of_birth: dob, email_verified: result.email !== null, verified_at: result.email !== null ? 0 : null, has_password: false });
  identities.set(`${result.provider}:${result.subject}`, { userId: account.user.id, email: result.email, linkedAt: new Date().toISOString() });
  if (result.email === null) mailLink(account.user.id, "verify", email);
  const session = signIn(account);
  markFresh(session.token);
  return session;
});

route("GET", "/users/@me/oauth", ({ viewer }) => {
  const account = requireViewer(viewer);
  const linked: LinkedProvider[] = [];
  for (const [key, entry] of identities) {
    if (entry.userId !== account.user.id) continue;
    const provider = key.slice(0, key.indexOf(":"));
    linked.push({ provider, name: providers.find(p => p.id === provider)?.name ?? provider, email: entry.email, linked_at: entry.linkedAt });
  }
  return linked;
});

route("DELETE", "/users/@me/oauth/([a-z0-9_]+)", ({ viewer, params }) => {
  const account = requireViewer(viewer);
  const mine = [...identities].filter(([, entry]) => entry.userId === account.user.id);
  const target = mine.find(([key]) => key.startsWith(`${params[0]}:`));
  if (!target) return invalid("provider", "That sign-in method is not linked.");
  if (!accountState(account.user.id).has_password && mine.length <= 1) invalid("provider", "This is your only way to sign in. Set a password first.");
  identities.delete(target[0]);
  return undefined;
});

// Test hooks: read the outbox, change instance settings.
interface AccountHooks {
  outbox(): MockMail[];
  instance(patch: Partial<InstanceInfo>): void;
}

if (typeof window !== "undefined") {
  (window as unknown as { __vokkoMockAccounts: AccountHooks }).__vokkoMockAccounts = {
    outbox: () => outbox.map(mail => ({ ...mail })),
    instance: patch => Object.assign(instance, patch),
  };
}
