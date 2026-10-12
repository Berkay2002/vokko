import { appStore } from "../api/store";
import type { Snowflake, ThreadMember, UpdateThreadMemberRequest } from "../api/types";
import { unmute, useLocalState } from "../shell/localState";
import { patchThreadMember } from "./memberSettings";

/**
 * One-time move of thread mutes that older builds kept per device (`mutedUntil[threadId]` in local state) onto the server's
 * thread member, which is the only mute threads read now. Runs once per thread per session once its member is known.
 */

/** The PATCH an old local entry becomes, or null when it has expired (or there is none). -1 is forever. */
export function localThreadMutePatch(until: number | undefined, now: number): UpdateThreadMemberRequest | null {
  if (until === -1) return { muted: true, mute_config: null };
  if (until === undefined || until <= now) return null;
  return { muted: true, mute_config: { end_time: new Date(until).toISOString() } };
}

const handled = new Set<Snowflake>();

/** Test hook: forget which threads were handled this session. */
export function resetThreadMuteMigration(): void {
  handled.clear();
}

const memberOf = (threadId: Snowflake): ThreadMember | undefined => appStore.getState().threads[threadId]?.member;

/**
 * Moves `threadId`'s local mute onto its thread member, then drops the local entry. An expired entry is just dropped, and so
 * is one for a thread whose member is already muted (the server's choice wins). Does nothing until the member is known; after
 * that, at most once per thread. When the PATCH fails the local entry stays (it is ignored anyway) for the next session.
 */
export async function migrateLocalThreadMute(threadId: Snowflake, now = Date.now()): Promise<void> {
  if (handled.has(threadId)) return;
  const member = memberOf(threadId);
  if (!member) return;
  handled.add(threadId);
  const until = useLocalState.getState().mutedUntil[threadId];
  if (until === undefined) return;
  const patch = member.muted ? null : localThreadMutePatch(until, now);
  if (patch) {
    await patchThreadMember(threadId, patch);
    if (!memberOf(threadId)?.muted) return;
  }
  unmute(threadId);
}

/** Every local mute entry that belongs to a known thread with a member, migrated as threads arrive. Call once at startup. */
export function startThreadMuteMigration(): () => void {
  const scan = () => {
    const { threads } = appStore.getState();
    for (const id of Object.keys(useLocalState.getState().mutedUntil)) {
      if (!handled.has(id) && threads[id]?.member) void migrateLocalThreadMute(id);
    }
  };
  let threads = appStore.getState().threads;
  const off = appStore.subscribe(s => {
    if (s.threads === threads) return;
    threads = s.threads;
    scan();
  });
  scan();
  return off;
}
