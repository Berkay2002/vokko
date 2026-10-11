import { useEffect, useState } from "react";
import { CalendarPlus } from "lucide-react";
import type { Snowflake } from "../api/types";
import { closeCommunityModal, openCreateEvent, openEventDetail } from "./communityModals";
import { EventCard } from "./EventCard";
import { Modal, Perm, usePermissions } from "./shell";
import { loadEvents, useCommunity } from "./store";

/** "Events" dialog: everything scheduled or running in the server, soonest first. */
export function EventsModal({ guildId }: { guildId: Snowflake }) {
  const events = useCommunity(s => s.events[guildId]);
  const loaded = useCommunity(s => !!s.loaded[guildId]);
  const [error, setError] = useState<string | null>(null);
  const { can } = usePermissions(guildId);
  const canCreate = can(Perm.CREATE_EVENTS) || can(Perm.MANAGE_EVENTS);

  useEffect(() => {
    loadEvents(guildId, true).catch(() => setError("Couldn't load the events."));
  }, [guildId]);

  const list = events ?? [];
  return (
    <Modal
      open
      onClose={closeCommunityModal}
      title="Events"
      className="modal-medium cm-modal"
      footer={
        canCreate ? (
          <button type="button" className="btn" onClick={() => openCreateEvent(guildId)}>
            <CalendarPlus size={18} aria-hidden="true" />
            Create Event
          </button>
        ) : undefined
      }
    >
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {!loaded && !error && <p className="cm-empty">Loading…</p>}
      {loaded && list.length === 0 && (
        <div className="cm-empty">
          <CalendarPlus size={48} aria-hidden="true" />
          <h3>There are no upcoming events</h3>
          <p>{canCreate ? "Schedule something to look forward to: a movie night, a game session, a meetup." : "When someone schedules an event, it shows up here."}</p>
        </div>
      )}
      {list.length > 0 && (
        <ul className="cm-event-list" aria-label="Upcoming events">
          {list.map(event => (
            <EventCard key={event.id} event={event} onOpen={() => openEventDetail(guildId, event.id, "events")} onError={setError} />
          ))}
        </ul>
      )}
    </Modal>
  );
}
