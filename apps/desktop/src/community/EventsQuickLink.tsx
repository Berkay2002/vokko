import { useEffect } from "react";
import { CalendarDays } from "lucide-react";
import { ScheduledEventStatus, type Snowflake } from "../api/types";
import { openEvents } from "./communityModals";
import { loadEvents, useCommunity } from "./store";

/** The "Events" row under the server header: a calendar icon and how many events are scheduled or running. */
export function EventsQuickLink({ guildId }: { guildId: Snowflake }) {
  const events = useCommunity(s => s.events[guildId]);
  useEffect(() => {
    void loadEvents(guildId).catch(() => undefined);
  }, [guildId]);
  const count = events?.length ?? 0;
  const live = events?.some(e => e.status === ScheduledEventStatus.Active) ?? false;
  const label = count > 0 ? `${count} ${count === 1 ? "Event" : "Events"}` : "Events";
  return (
    <button type="button" className="cm-quicklink" aria-haspopup="dialog" onClick={() => openEvents(guildId)}>
      <CalendarDays size={20} aria-hidden="true" />
      <span className="cm-quicklink-label">{label}</span>
      {live && <span className="cm-live-dot" role="img" aria-label="An event is happening now" />}
    </button>
  );
}
