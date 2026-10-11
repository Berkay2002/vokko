// Route registry shared by routes.ts and moderation.ts (kept separate so the two files can register routes without an import cycle).

import type { MockAccount } from "./db";

export interface Ctx {
  viewer: MockAccount;
  params: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
}

export type Handler = (ctx: Ctx) => unknown;

export const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];

export function route(method: string, pattern: string, handler: Handler): void {
  routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler });
}

export const ID = "(\\d+)";

/** The `X-Audit-Log-Reason` of the request being handled (handlers run synchronously, one at a time). */
let auditReason: string | null = null;
export const currentAuditReason = (): string | null => auditReason;
export function withAuditReason<T>(reason: string | null | undefined, run: () => T): T {
  auditReason = reason?.trim() ? reason.trim().slice(0, 512) : null;
  try {
    return run();
  } finally {
    auditReason = null;
  }
}
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
