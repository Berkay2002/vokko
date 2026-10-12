import { updateThreadMember } from "../api/rest";
import { appStore } from "../api/store";
import { ThreadMemberFlags, type Snowflake, type ThreadMember, type UpdateThreadMemberRequest } from "../api/types";
import { chatToast } from "../chat/toast";

const NOTIFY_BITS = ThreadMemberFlags.AllMessages | ThreadMemberFlags.OnlyMentions | ThreadMemberFlags.NoMessages;

/** What the server will answer for `patch`: only the notify bits change, muting without a config is forever, unmuting clears the end. */
export function applyMemberPatch(member: ThreadMember, patch: UpdateThreadMemberRequest): ThreadMember {
  const flags = patch.flags === undefined ? member.flags : (member.flags & ThreadMemberFlags.HasInteracted) | (patch.flags & NOTIFY_BITS);
  const muted = patch.muted ?? (patch.mute_config ? true : member.muted);
  if (!muted) return { ...member, flags, muted: false, mute_config: null };
  const config = patch.mute_config ?? (patch.muted === undefined ? member.mute_config : null);
  return { ...member, flags, muted: true, mute_config: config ?? { end_time: null } };
}

/** Optimistic update of the viewer's own thread member; reverted with a toast when the server refuses. */
export async function patchThreadMember(threadId: Snowflake, patch: UpdateThreadMemberRequest): Promise<void> {
  const thread = appStore.getState().threads[threadId];
  const before = thread?.member;
  if (!thread || !before) return;
  const optimistic = applyMemberPatch(before, patch);
  appStore.getState().upsertThread({ ...thread, member: optimistic });
  try {
    const member = await updateThreadMember(threadId, patch);
    const current = appStore.getState().threads[threadId];
    if (current?.member === optimistic) appStore.getState().upsertThread({ ...current, member });
  } catch {
    // Revert only our own guess: a THREAD_MEMBER_UPDATE or a later patch since then wins.
    const current = appStore.getState().threads[threadId];
    if (current?.member === optimistic) appStore.getState().upsertThread({ ...current, member: before });
    chatToast("Could not update the thread's notification settings.");
  }
}
