// The skip vote and host lines shared by the Watch Together, Stremio and Spotify tiles (docs/design/bot-control.md section 4).

import { Avatar } from "../chat/Avatar";
import { displayName, useStore } from "../api/store";
import type { MediaControl, Snowflake } from "../api/types";
import "./mediaVotes.css";

/** "2 of 3 voted to skip" with the voters' avatars; nothing while nobody has voted. */
export function MediaVotes({ control }: { control: MediaControl }) {
  const users = useStore(s => s.users);
  const votes = control.skip_votes;
  if (votes.length === 0) return null;
  return (
    <span className="media-votes" data-skip-votes={votes.length} role="status">
      <span className="media-votes-avatars" aria-hidden="true">
        {votes.slice(0, 5).map(id => {
          const user = users[id];
          return user ? <Avatar key={id} user={user} size={16} /> : null;
        })}
      </span>
      {votes.length} of {control.skip_needed} voted to skip
    </span>
  );
}

/** "Host: Alex" when the host is no longer whoever started it, else null. */
export function useHostLabel(control: MediaControl, startedBy: Snowflake): string | null {
  const host = useStore(s => s.users[control.host_id]);
  return control.host_id !== startedBy && host ? `Host: ${displayName(host)}` : null;
}
