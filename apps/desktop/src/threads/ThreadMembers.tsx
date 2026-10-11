import { useEffect, useMemo, useState } from "react";
import { Search, UserMinus, UserPlus } from "lucide-react";
import { addThreadMember, listThreadMembers, removeThreadMember } from "../api/rest";
import { displayName, useStore } from "../api/store";
import type { Channel, ThreadMember, User } from "../api/types";
import { Avatar } from "../shell/Avatar";
import type { ThreadRights } from "./rights";
import "./threads.css";

/** Members of a thread (GET thread-members), with remove for the owner / MANAGE_THREADS and an add-by-name list when allowed. */
export function ThreadMembers({ thread, rights }: { thread: Channel; rights: ThreadRights }) {
  const [members, setMembers] = useState<ThreadMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const guildMembers = useStore(s => (thread.guild_id ? s.members[thread.guild_id] : undefined));
  const users = useStore(s => s.users);
  const meId = useStore(s => s.me?.id);
  const count = thread.member_count;

  useEffect(() => {
    let live = true;
    listThreadMembers(thread.id)
      .then(list => live && setMembers(list))
      .catch(() => live && setError("Members could not be loaded."));
    return () => {
      live = false;
    };
    // member_count changes whenever somebody joins or leaves
  }, [thread.id, count]);

  const nameOf = (user: User | undefined, id: string) => (user ? displayName(user, guildMembers?.[id]) : "Unknown user");
  const joined = useMemo(() => new Set((members ?? []).map(m => m.user_id)), [members]);
  const needle = filter.trim().toLowerCase();
  const candidates = useMemo(
    () =>
      rights.canAddMembers && needle
        ? Object.values(guildMembers ?? {})
            .filter(m => !joined.has(m.user.id) && displayName(m.user, m).toLowerCase().includes(needle))
            .slice(0, 6)
        : [],
    [rights.canAddMembers, needle, guildMembers, joined],
  );
  const run = (action: Promise<void>) => action.catch(() => setError("That did not work."));

  return (
    <div className="thread-members" role="dialog" aria-label="Thread members">
      <h3 className="thread-members-title">Members{count !== undefined ? ` — ${count}` : ""}</h3>
      {rights.canAddMembers && (
        <label className="threads-search thread-members-add">
          <input value={filter} placeholder="Add people by name" aria-label="Add people by name" onChange={e => setFilter(e.target.value)} />
          <Search size={16} aria-hidden="true" />
        </label>
      )}
      {candidates.map(m => (
        <div key={m.user.id} className="thread-member">
          <Avatar user={m.user} size={24} />
          <span className="thread-member-name">{displayName(m.user, m)}</span>
          <button type="button" className="icon-button" aria-label={`Add ${displayName(m.user, m)}`} onClick={() => void run(addThreadMember(thread.id, m.user.id).then(() => setFilter("")))}>
            <UserPlus size={16} />
          </button>
        </div>
      ))}
      {error && <p className="field-error">{error}</p>}
      <div className="thread-members-list">
        {(members ?? []).map(m => {
          const user = users[m.user_id] ?? guildMembers?.[m.user_id]?.user;
          return (
            <div key={m.user_id} className="thread-member">
              {user ? <Avatar user={user} size={24} /> : <span className="thread-member-blank" />}
              <span className="thread-member-name">{nameOf(user, m.user_id)}</span>
              {m.user_id === thread.owner_id && <span className="thread-member-owner">Owner</span>}
              {(rights.isOwner || rights.manage) && m.user_id !== meId && m.user_id !== thread.owner_id && (
                <button type="button" className="icon-button" aria-label={`Remove ${nameOf(user, m.user_id)}`} onClick={() => void run(removeThreadMember(thread.id, m.user_id))}>
                  <UserMinus size={16} />
                </button>
              )}
            </div>
          );
        })}
        {members === null && !error && <p className="threads-empty">Loading…</p>}
      </div>
    </div>
  );
}
