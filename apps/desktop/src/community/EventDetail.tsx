import { useEffect, useRef, useState } from "react";
import { CalendarDays, MapPin, Pencil, Repeat, Volume2 } from "lucide-react";
import { ScheduledEventEntityType, ScheduledEventStatus, type GuildScheduledEvent, type ScheduledEventUser, type Snowflake } from "../api/types";
import { closeCommunityModal, openEvents, useCommunityModal } from "./communityModals";
import { InterestedButton, JoinEventButton, useEventPlace } from "./EventCard";
import { errorText } from "./errors";
import { describeRecurrence, formatEventRange, statusLabel } from "./eventUtil";
import { Avatar, Modal, Perm, appStore, displayName, request, resolveUrl, useChatLocale, useStore, usePermissions } from "./shell";
import { deleteEvent, editEvent, useCommunity } from "./store";

const AVATARS_SHOWN = 12;

function useEvent(guildId: Snowflake, eventId: Snowflake): { event: GuildScheduledEvent | null; missing: boolean; set(event: GuildScheduledEvent): void } {
  const fromList = useCommunity(s => s.events[guildId]?.find(e => e.id === eventId));
  const [fetched, setFetched] = useState<GuildScheduledEvent | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    request<GuildScheduledEvent>("GET", `/guilds/${guildId}/scheduled-events/${eventId}`)
      .then(event => live && setFetched(event))
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [guildId, eventId]);
  // Once the live copy has been in the list and leaves it (deleted, finished, or no longer visible to us) the fetched copy is stale:
  // it is dropped and asked for again, which shows the finished event or "doesn't exist any more".
  const wasListed = useRef(false);
  useEffect(() => {
    if (fromList) {
      wasListed.current = true;
      return;
    }
    if (!wasListed.current) return;
    wasListed.current = false;
    let live = true;
    setFetched(null);
    request<GuildScheduledEvent>("GET", `/guilds/${guildId}/scheduled-events/${eventId}`)
      .then(event => {
        if (!live) return;
        setMissing(false);
        setFetched(event);
      })
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [fromList, guildId, eventId]);
  // The list copy is live (gateway events); the fetched copy covers finished events and the first paint.
  return { event: fromList ?? fetched, missing: missing && !fromList, set: setFetched };
}

function Interested({ guildId, event }: { guildId: Snowflake; event: GuildScheduledEvent }) {
  const [people, setPeople] = useState<ScheduledEventUser[]>([]);
  useEffect(() => {
    let live = true;
    request<ScheduledEventUser[]>("GET", `/guilds/${guildId}/scheduled-events/${event.id}/users?limit=100`)
      .then(list => live && setPeople(list))
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // A changed count means somebody (un)marked themselves.
  }, [guildId, event.id, event.user_count]);
  const members = useStore(s => s.members[guildId]);
  if (people.length === 0) return <p className="cm-muted">Nobody has marked themselves as interested yet.</p>;
  return (
    <div className="cm-interested-row">
      <ul className="cm-avatars" aria-label="People who are interested">
        {people.slice(0, AVATARS_SHOWN).map(p => (
          <li key={p.user.id} title={displayName(p.user, members?.[p.user.id])}>
            <Avatar user={p.user} guildId={guildId} size={32} decoration={false} />
          </li>
        ))}
      </ul>
      <span className="cm-muted">
        {people.length === 1 ? displayName(people[0]!.user, members?.[people[0]!.user.id]) : `${event.user_count} interested`}
        {people.length > AVATARS_SHOWN ? ` · +${event.user_count - AVATARS_SHOWN} more` : ""}
      </span>
    </div>
  );
}

type Confirm = "cancel" | "delete" | null;

/** Details of one event: when, where, who is interested, and for people with permission start / end / edit / cancel / delete. */
export function EventDetail({ guildId, eventId, from }: { guildId: Snowflake; eventId: Snowflake; from?: "events" }) {
  const { event, missing, set } = useEvent(guildId, eventId);
  const locale = useChatLocale();
  const { can } = usePermissions(guildId);
  const meId = useStore(s => s.me?.id);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const place = useEventPlace(event ?? ({ entity_type: ScheduledEventEntityType.External, entity_metadata: null, channel_id: null } as GuildScheduledEvent));
  const creator = useStore(s => (event?.creator_id ? s.users[event.creator_id] : undefined));

  const back = () => (from === "events" ? openEvents(guildId) : closeCommunityModal());
  if (missing) {
    return (
      <Modal open onClose={back} title="Event" footer={<button type="button" className="btn" onClick={back}>Close</button>}>
        <p className="modal-text">This event doesn&apos;t exist any more.</p>
      </Modal>
    );
  }
  if (!event) return <Modal open onClose={back} title="Event"><p className="cm-empty">Loading…</p></Modal>;

  const manage = can(Perm.MANAGE_EVENTS) || (can(Perm.CREATE_EVENTS) && event.creator_id === meId);
  const finished = event.status === ScheduledEventStatus.Completed || event.status === ScheduledEventStatus.Canceled;
  const live = event.status === ScheduledEventStatus.Active;
  const cover = event.image ? resolveUrl(event.image) : null;
  const rule = describeRecurrence(event.recurrence_rule);

  const run = (action: () => Promise<GuildScheduledEvent | void>) => {
    setBusy(true);
    setError(null);
    action()
      .then(result => {
        if (result) set(result);
      })
      .catch(e => setError(errorText(e)))
      .finally(() => {
        setBusy(false);
        setConfirm(null);
      });
  };
  const setStatus = (status: ScheduledEventStatus) => run(() => editEvent(guildId, event.id, { status }));
  const remove = () =>
    run(async () => {
      await deleteEvent(guildId, event.id);
      back();
    });

  return (
    <Modal open onClose={back} title={null} hideClose={false} className="modal-medium cm-modal cm-detail" labelledBy="cm-detail-title">
      {cover && <img className="cm-detail-cover" src={cover} alt="" draggable={false} />}
      <div className="cm-detail-body">
        <div className={`cm-event-when${live ? " live" : ""}${finished ? " finished" : ""}`}>
          <CalendarDays size={16} aria-hidden="true" />
          <span>{finished || live ? `${statusLabel(event.status)} · ` : ""}{formatEventRange(event, undefined, locale)}</span>
        </div>
        <h2 id="cm-detail-title" className="cm-detail-title">
          {event.name}
        </h2>
        <div className="cm-detail-facts">
          <span className="cm-event-place">
            {place.icon === "pin" ? <MapPin size={18} aria-hidden="true" /> : <Volume2 size={18} aria-hidden="true" />}
            <span>{place.text}</span>
          </span>
          {rule && (
            <span className="cm-event-place">
              <Repeat size={18} aria-hidden="true" />
              <span>{rule}</span>
            </span>
          )}
        </div>
        {event.description && <p className="cm-detail-description">{event.description}</p>}
        <h3 className="field-label cm-detail-label">Interested</h3>
        <Interested guildId={guildId} event={event} />
        {creator && <p className="cm-muted cm-detail-creator">Created by {displayName(creator, appStore.getState().members[guildId]?.[creator.id])}</p>}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {confirm && (
          <div className="cm-confirm" role="alertdialog" aria-label={confirm === "delete" ? "Delete this event?" : "Cancel this event?"}>
            <p>{confirm === "delete" ? "Delete this event for everyone? This can't be undone." : "Cancel this event? People who marked themselves as interested will see that it is canceled."}</p>
            <div className="cm-confirm-actions">
              <button type="button" className="btn btn-link" disabled={busy} onClick={() => setConfirm(null)}>
                Keep it
              </button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => (confirm === "delete" ? remove() : setStatus(ScheduledEventStatus.Canceled))}>
                {confirm === "delete" ? "Delete Event" : "Cancel Event"}
              </button>
            </div>
          </div>
        )}
        <div className="cm-detail-actions">
          <JoinEventButton event={event} onJoined={closeCommunityModal} />
          <InterestedButton event={event} onError={setError} />
          {manage && !finished && (
            <>
              {event.status === ScheduledEventStatus.Scheduled && (
                <button type="button" className="btn btn-sm btn-success" disabled={busy} onClick={() => setStatus(ScheduledEventStatus.Active)}>
                  Start Event
                </button>
              )}
              {live && (
                <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => setStatus(ScheduledEventStatus.Completed)}>
                  End Event
                </button>
              )}
              <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => useCommunityModal.getState().open({ type: "wizard", guildId, eventId: event.id, from: "detail" })}>
                <Pencil size={16} aria-hidden="true" />
                Edit Event
              </button>
              {event.status === ScheduledEventStatus.Scheduled && (
                <button type="button" className="btn btn-sm btn-link cm-danger-text" disabled={busy} onClick={() => setConfirm("cancel")}>
                  Cancel Event
                </button>
              )}
            </>
          )}
          {manage && (
            <button type="button" className="btn btn-sm btn-link cm-danger-text" disabled={busy} onClick={() => setConfirm("delete")}>
              Delete Event
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
