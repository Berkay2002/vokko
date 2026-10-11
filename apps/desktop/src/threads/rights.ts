import { useMemo } from "react";
import { Perm, channelPermissions, hasBit, threadPermissions } from "../api/permissions";
import { useStore } from "../api/store";
import type { Channel, Guild, GuildMember, Snowflake } from "../api/types";

export interface ThreadRights {
  /** MANAGE_THREADS in the parent. */
  manage: boolean;
  isOwner: boolean;
  /** Rename, archive, auto-archive, tags: the owner or MANAGE_THREADS, and a locked thread only for MANAGE_THREADS. */
  canEdit: boolean;
  /** Lock and pin need MANAGE_THREADS. */
  canLock: boolean;
  canDelete: boolean;
  /** SEND_MESSAGES_IN_THREADS in the parent (and not locked, unless MANAGE_THREADS). Sending into an archived thread unarchives it. */
  canSend: boolean;
  canAddMembers: boolean;
  joined: boolean;
}

const NONE: ThreadRights = { manage: false, isOwner: false, canEdit: false, canLock: false, canDelete: false, canSend: false, canAddMembers: false, joined: false };

/** What the viewer may do in a thread; the server stays authoritative. Pure: used by the hook below and by tests. */
export function threadRights(thread: Channel, guild: Guild, member: Pick<GuildMember, "roles" | "communication_disabled_until"> | undefined, meId: Snowflake, parent: Channel | undefined): ThreadRights {
  const parentBits = channelPermissions(guild, { id: meId, roles: member?.roles ?? [], communication_disabled_until: member?.communication_disabled_until }, parent);
  const bits = threadPermissions(parentBits);
  const manage = hasBit(parentBits, Perm.MANAGE_THREADS);
  const isOwner = thread.owner_id === meId;
  const locked = thread.thread_metadata?.locked === true;
  const joined = !!thread.member;
  const canSend = hasBit(bits, Perm.SEND_MESSAGES) && (!locked || manage);
  return {
    manage,
    isOwner,
    canEdit: (isOwner || manage) && (!locked || manage),
    canLock: manage,
    canDelete: isOwner || manage,
    canSend,
    canAddMembers: hasBit(bits, Perm.SEND_MESSAGES) && (isOwner || manage || (thread.type === 12 && joined && thread.thread_metadata?.invitable !== false)),
    joined,
  };
}

export function useThreadRights(thread: Channel | undefined): ThreadRights {
  const guild = useStore(s => (thread?.guild_id ? s.guilds[thread.guild_id] : undefined));
  const meId = useStore(s => s.me?.id);
  const member = useStore(s => (thread?.guild_id && meId ? s.members[thread.guild_id]?.[meId] : undefined));
  const parent = useStore(s => (thread?.parent_id ? s.channels[thread.parent_id] : undefined));
  return useMemo(() => (thread && guild && meId ? threadRights(thread, guild, member, meId, parent) : NONE), [thread, guild, meId, member, parent]);
}
