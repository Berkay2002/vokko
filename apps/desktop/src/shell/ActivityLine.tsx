import { useEffect, useState } from "react";
import { Gamepad2 } from "lucide-react";
import { activityLabel, formatClock, formatPlaytime, playingActivity, shownActivity } from "../activity/format";
import { useStore } from "../api/store";
import type { Activity, Snowflake } from "../api/types";

/** Re-renders every `intervalMs` while mounted; the value is Date.now(). */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The "Playing X" the user is shown with: the first Playing activity of their presence, null when there is none. */
export function usePlaying(userId: Snowflake | null | undefined): Activity | null {
  return useStore(s => (userId ? playingActivity(s.presences[userId]) : null));
}

/** What lists show for a user: the game they play, else the song on Spotify. */
export function useShownActivity(userId: Snowflake | null | undefined): Activity | null {
  return useStore(s => (userId ? shownActivity(s.presences[userId]) : null));
}

/** One line for lists: "Playing Factorio · 12m" or "Listening to Spotify". Truncates with an ellipsis through the `className` the caller styles. */
export function ActivityLine({ activity, className }: { activity: Activity; className?: string }) {
  const now = useNow(30_000);
  if (activity.type === 2) {
    return (
      <span className={className ?? "activity-line"} data-testid="activity-line" title={activity.details ? `${activityLabel(activity)}: ${activity.details}` : activityLabel(activity)}>
        Listening to <strong>Spotify</strong>
      </span>
    );
  }
  const elapsed = formatPlaytime(activity.timestamps?.start, now);
  return (
    <span className={className ?? "activity-line"} data-testid="activity-line" title={elapsed ? `Playing ${activity.name} for ${elapsed}` : `Playing ${activity.name}`}>
      Playing <strong>{activity.name}</strong>
      {elapsed && <span className="activity-elapsed"> · {elapsed}</span>}
    </span>
  );
}

/** The profile popout's activity block: "Playing a game", the name and a live elapsed clock. */
export function ActivityCard({ activity }: { activity: Activity }) {
  const start = activity.timestamps?.start;
  const now = useNow(1000);
  return (
    <div className="activity-card" data-testid="activity-card">
      <div className="activity-card-heading">Playing a game</div>
      <div className="activity-card-body">
        <span className="activity-card-icon" aria-hidden="true">
          <Gamepad2 size={24} />
        </span>
        <span className="activity-card-text">
          <span className="activity-card-name">{activity.name}</span>
          {start ? <span className="activity-card-time">{formatClock(start, now)} elapsed</span> : null}
        </span>
      </div>
    </div>
  );
}
