// "Report a problem" log tail: console warnings/errors, uncaught errors and voice events in a bounded ring, scrubbed of
// anything that looks like a secret before it is stored. Nothing here is sent until the user submits a report.

const MAX_LINES = 500;
const MAX_LINE_CHARS = 1000;
const REDACTED = "[redacted]";

/** Order matters: `Bearer x` goes before the key rule so `Authorization: Bearer x` loses the token, not just "Bearer". */
const RULES: [RegExp, string][] = [
  // JWTs (LiveKit tokens, OAuth id tokens)
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, REDACTED],
  [/\b(Bearer|Bot|Basic)\s+[^\s"',;]+/gi, `$1 ${REDACTED}`],
  // key=value, key: value and "key":"value" for anything named like a secret (query strings, headers, JSON)
  [/([\w-]*(?:token|secret|passw(?:or)?d|signature|sig|auth\w*|api[_-]?key|cookie|session|credential|ticket)[\w-]*)(["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"'&,;}\]]+/gi, `$1$2${REDACTED}`],
  // OAuth callback parameters
  [/([?&#](?:code|state)=)[^\s&#"']+/gi, `$1${REDACTED}`],
  // long opaque strings with both letters and digits (session tokens are hex, upload keys base64url); snowflakes are digits only
  [/\b(?=[\w+=-]*\d)(?=[\w+=-]*[A-Za-z])[\w+=-]{24,}/g, REDACTED],
];

export function scrub(text: string): string {
  return RULES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

/** Message text never goes into a report: drop `content` fields of logged objects. */
function replacer(key: string, value: unknown): unknown {
  return key === "content" ? undefined : value;
}

function format(part: unknown): string {
  if (typeof part === "string") return part;
  if (part instanceof Error) return `${part.name}: ${part.message}${part.stack ? `\n${part.stack.split("\n").slice(1, 4).join("\n")}` : ""}`;
  try {
    return JSON.stringify(part, replacer) ?? String(part);
  } catch {
    return String(part);
  }
}

const lines: string[] = [];

/** Adds one scrubbed line; the oldest goes once the ring holds MAX_LINES. */
export function recordLog(level: string, parts: unknown[]): void {
  const text = scrub(parts.map(format).join(" "));
  lines.push(`${new Date().toISOString()} ${level} ${text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text}`);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

export function recentLogs(): string {
  return lines.join("\n");
}

export function clearLogs(): void {
  lines.length = 0;
}

let installed = false;

/** Copies console.warn/error and uncaught errors into the ring (once; the console keeps printing as before). */
export function installLogCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  for (const level of ["warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        recordLog(level, args);
      } catch {
        // a log line we cannot format must never break the caller
      }
      original(...args);
    };
  }
  window.addEventListener("error", event => recordLog("uncaught", [event.error ?? event.message]));
  window.addEventListener("unhandledrejection", event => recordLog("unhandled", [event.reason]));
}
