import { call, isDesktop, onDesktopEvent } from "./tauri";

/** A parsed `vokko://` link. Mirrors `links::DeepLink` in src-tauri. */
export type DeepLink = { kind: "invite"; code: string };

const LINK_EVENT = "desktop-deep-link";

/** Where an invite link goes in the SPA. */
export const invitePath = (code: string): string => `/invite/${code}`;

/** Default routing: push the SPA path and let react-router (BrowserRouter listens to popstate) pick it up. */
export function routeDeepLink(link: DeepLink): void {
  if (typeof window === "undefined") return;
  const path = link.kind === "invite" ? invitePath(link.code) : null;
  if (!path || window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

let started = false;

/**
 * Starts delivering deep links to `handler` (default: `routeDeepLink`). Links that launched the app or were
 * forwarded before this call are delivered right away. Call once at startup; later calls are ignored.
 * Resolves to an unsubscribe function (a no-op outside Tauri).
 */
export async function initDeepLinks(handler: (link: DeepLink) => void = routeDeepLink): Promise<() => void> {
  if (!isDesktop() || started) return () => undefined;
  started = true;
  // Listen first, then drain the queue: a link arriving in between is delivered once either way.
  const unlisten = await onDesktopEvent<DeepLink>(LINK_EVENT, handler);
  const pending = await call<DeepLink[]>("desktop_take_pending_links", undefined, []);
  for (const link of pending) handler(link);
  return () => {
    unlisten();
    started = false;
  };
}
