import { useState } from "react";
import { Music } from "lucide-react";
import { formatTrackTime, spotifyImageUrl, spotifyOpenUrl } from "../activity/format";
import type { Activity } from "../api/types";
import { useNow } from "./ActivityLine";

/** Album art from the validated image id, else (no id, or it did not load) a Spotify-green tile with a music note. */
export function SpotifyArt({ activity, className }: { activity: Activity; className: string }) {
  const url = spotifyImageUrl(activity);
  const [failed, setFailed] = useState(false);
  if (url && !failed) return <img className={className} src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  return (
    <span className={`${className} spotify-art-placeholder`} aria-hidden="true">
      <Music size={24} />
    </span>
  );
}

/** The Discord-style "Listening to Spotify" block of the profile popout, DM profile panel and full profile: art, title, artists,
 *  a progress bar ticking from the timestamps and Play on Spotify. The bar only changes width, it never animates. */
export function SpotifyCard({ activity }: { activity: Activity }) {
  const start = activity.timestamps?.start;
  const end = activity.timestamps?.end;
  const now = useNow(1000);
  // no bar for a length that is not a song (another user can send any end); a day covers the longest tracks
  const total = start !== undefined && end !== undefined && end > start && end - start <= 86_400_000 ? end - start : 0;
  const elapsed = total > 0 ? Math.min(Math.max(0, now - (start ?? now)), total) : 0;
  return (
    <div className="activity-card spotify-card" data-testid="spotify-card">
      <div className="activity-card-heading">Listening to Spotify</div>
      <div className="activity-card-body">
        <SpotifyArt activity={activity} className="spotify-card-art" />
        <span className="activity-card-text">
          <span className="activity-card-name" data-testid="spotify-title">{activity.details ?? "Spotify"}</span>
          {activity.state && <span className="activity-card-time" data-testid="spotify-artists">by {activity.state}</span>}
        </span>
      </div>
      {total > 0 && (
        <div className="spotify-progress">
          <div className="spotify-progress-bar" role="progressbar" aria-label="Track progress" aria-valuemin={0} aria-valuemax={Math.round(total / 1000)} aria-valuenow={Math.round(elapsed / 1000)}>
            <div className="spotify-progress-fill" style={{ width: `${(elapsed / total) * 100}%` }} />
          </div>
          <div className="spotify-progress-times">
            <span>{formatTrackTime(elapsed)}</span>
            <span>{formatTrackTime(total)}</span>
          </div>
        </div>
      )}
      <a className="btn btn-secondary spotify-play" href={spotifyOpenUrl(activity)} target="_blank" rel="noopener noreferrer">
        Play on Spotify
      </a>
    </div>
  );
}
