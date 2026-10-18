import { call, isDesktop, onDesktopEvent } from "./tauri";

/** A parsed `vokko://` link. Mirrors `links::DeepLink` in src-tauri; `url` is always the full original URL. */
export type DeepLink =
  | { kind: "invite"; code: string; url: string }
  /** `vokko://template/<code>`: opens the server template page. */
  | { kind: "template"; code: string; url: string }
  /** `vokko://auth/callback?code=…&state=…`, the OAuth redirect back from the system browser. Parse the query from `url`. */
  | { kind: "auth"; url: string };

export type DeepLinkHandler = (link: DeepLink) => void;

const LINK_EVENT = "desktop-deep-link";
/** Links nobody was listening for yet (an OAuth redirect can beat the sign-in code's subscription on a cold start). */
const MAX_BACKLOG = 8;

/** Where an invite link goes in the SPA when no listener claimed it. */
export const invitePath = (code: string): string => `/invite/${code}`;
export const templatePath = (code: string): string => `/template/${code}`;

/** Default routing for invites: push the SPA path and let react-router (BrowserRouter listens to popstate) pick it up. */
export function routeDeepLink(link: DeepLink): void {
  if (typeof window === "undefined" || link.kind === "auth") return;
  const path = link.kind === "invite" ? invitePath(link.code) : templatePath(link.code);
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

interface Listener {
  handler: DeepLinkHandler;
  /** Link kinds this listener wants; undefined means all of them. */
  kinds?: readonly DeepLink["kind"][];
}

const listeners = new Set<Listener>();
let backlog: DeepLink[] = [];

const wants = (listener: Listener, link: DeepLink): boolean => !listener.kinds || listener.kinds.includes(link.kind);

function deliver(link: DeepLink): void {
  const targets = [...listeners].filter(listener => wants(listener, link));
  if (targets.length > 0) {
    for (const listener of targets) listener.handler(link);
    return;
  }
  if (link.kind !== "auth") routeDeepLink(link);
  else backlog = [...backlog, link].slice(-MAX_BACKLOG);
}

/**
 * Subscribes to every deep link (`vokko://invite/<code>`, `vokko://auth/callback?…`). Auth links that arrived before the first
 * subscriber are replayed to it. While at least one listener wants a link's kind, it goes to those listeners instead of
 * `routeDeepLink`. Pass `kinds` to receive only those kinds: links of other kinds stay queued for a later subscriber, so a
 * handler that only cares about invites does not swallow an OAuth redirect meant for the sign-in code.
 * Returns an unsubscribe function. Never fires outside Tauri.
 */
export function onDeepLink(handler: DeepLinkHandler, options: { kinds?: readonly DeepLink["kind"][] } = {}): () => void {
  const listener: Listener = { handler, kinds: options.kinds };
  listeners.add(listener);
  const queued = backlog;
  backlog = [];
  for (const link of queued) {
    if (wants(listener, link)) handler(link);
    else backlog = [...backlog, link];
  }
  return () => {
    listeners.delete(listener);
  };
}

let started = false;

/**
 * Starts the Rust → JS link stream. Links that launched the app or were forwarded before this call are delivered right
 * away. Call once at startup (`initDesktop()` does); later calls are ignored. Resolves to a teardown (no-op outside Tauri).
 */
export async function initDeepLinks(): Promise<() => void> {
  if (!isDesktop() || started) return () => undefined;
  started = true;
  // Listen first, then drain the queue: a link arriving in between is delivered once either way.
  const unlisten = await onDesktopEvent<DeepLink>(LINK_EVENT, deliver);
  const pending = await call<DeepLink[]>("desktop_take_pending_links", undefined, []);
  for (const link of pending) deliver(link);
  return () => {
    unlisten();
    started = false;
  };
}

/** Test hook: drop listeners and the backlog. */
export function resetDeepLinks(): void {
  listeners.clear();
  backlog = [];
  started = false;
}
