// Automatic crash reports (POST /crash-reports): uncaught errors, unhandled rejections and, on the next start, a Rust panic the
// desktop shell wrote to disk. Off with Settings > Data & Privacy > "Send crash reports". Nothing but the version, OS, the route
// with ids removed and the scrubbed message and stack is sent; never message text, and only while signed in.
import { version as packageVersion } from "../../package.json";
import { getToken } from "../api/config";
import { gateway } from "../api/gateway";
import { createCrashReport } from "../api/rest";
import type { CrashKind, CreateCrashReportRequest } from "../api/types";
import { getAppVersion } from "../desktop";
import { call } from "../desktop/tauri";
import { getPrefs } from "../ui/prefs";
import { scrub } from "./logBuffer";

/** One crash loop must not spam the server (it also rate-limits: 10, then one a minute). */
const MAX_PER_SESSION = 10;
const MAX_MESSAGE = 1000;
const MAX_STACK = 16_000;
/** Browser noise with no bug behind it, and opaque cross-origin errors with nothing to read. */
const IGNORED = [/^ResizeObserver loop/, /^Script error\.?$/];

const sent = new Set<string>();
let version: string | null = null;

/** `/channels/123…/456…` → `/channels/:id/:id` (the server does the same). */
export function stripIds(path: string): string {
  return path.replace(/\d{5,}/g, ":id");
}

/** Tokens out (logBuffer's scrub), and the account name out of home-directory paths (panic backtraces, file URLs). */
export function clean(text: string): string {
  return scrub(text).replace(/([A-Za-z]:[\\/]+Users[\\/]+|\/Users\/|\/home\/)[^\\/\s:"'`]+/gi, "$1~");
}

function describe(reason: unknown): { message: string; stack: string } {
  if (reason instanceof Error) return { message: `${reason.name}: ${reason.message}`, stack: reason.stack ?? "" };
  if (typeof reason === "string") return { message: reason, stack: "" };
  // an object rejection (an API error body, say): only the fields that describe the failure, never data it carried
  const fields = Object.entries(Object(reason) as Record<string, unknown>).filter(
    ([key, value]) => ["name", "code", "status", "message"].includes(key) && (typeof value === "string" || typeof value === "number"),
  );
  return { message: fields.length ? JSON.stringify(Object.fromEntries(fields)) : `non-Error rejection (${typeof reason})`, stack: "" };
}

/** The request body, or null when this report is noise, a repeat, or over the session budget. */
export function buildReport(kind: CrashKind, reason: unknown, appVersion: string): CreateCrashReportRequest | null {
  const { message: raw, stack: rawStack } = describe(reason);
  const message = clean(raw).trim().slice(0, MAX_MESSAGE);
  if (message === "" || IGNORED.some(pattern => pattern.test(message))) return null;
  const key = `${kind}\n${message}`;
  if (sent.has(key) || sent.size >= MAX_PER_SESSION) return null;
  sent.add(key);
  return {
    kind,
    app_version: appVersion.slice(0, 64),
    os: navigator.userAgent.slice(0, 256),
    route: typeof location === "undefined" ? "" : stripIds(location.pathname).slice(0, 256),
    message,
    stack: clean(rawStack).slice(0, MAX_STACK),
  };
}

function enabled(): boolean {
  return getPrefs().sendCrashReports && getToken() !== null;
}

function report(kind: CrashKind, reason: unknown): void {
  if (!enabled()) return;
  const body = buildReport(kind, reason, version ?? `web ${packageVersion}`);
  // a failed report is dropped: reporting it would only loop
  if (body) createCrashReport(body).catch(() => undefined);
}

interface PendingPanic {
  message: string;
  location: string;
  backtrace: string;
  version: string;
}

/** Sends the panic the desktop shell saved before it died (taking it removes the file), once a session is up. */
async function sendPendingPanic(): Promise<void> {
  const panic = await call<PendingPanic | null>("desktop_take_crash", undefined, null);
  if (!panic || !enabled()) return;
  const body = buildReport("panic", panic.message, panic.version);
  if (body) createCrashReport({ ...body, route: "", stack: clean(`${panic.location}\n${panic.backtrace}`).slice(0, MAX_STACK) }).catch(() => undefined);
}

let installed = false;

export function installCrashReporter(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  void getAppVersion().then(v => (version = v ?? `web ${packageVersion}`));
  window.addEventListener("error", event => report("error", event.error ?? event.message));
  window.addEventListener("unhandledrejection", event => report("unhandled_rejection", event.reason));
  const off = gateway.on("READY", () => {
    off();
    void sendPendingPanic();
  });
}
