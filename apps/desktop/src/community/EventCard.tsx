import { useState } from "react";
import { CalendarDays, MapPin, Star, Users, Volume2 } from "lucide-react";
import { ScheduledEventEntityType, ScheduledEventStatus, type GuildScheduledEvent } from "../api/types";
import { errorText } from "./errors";
import { formatEventRange, joinLabel, statusLabel } from "./eventUtil";
import { appStore, go, guildPath, joinVoiceChannel, resolveUrl, useChatLocale, useStore } from "./shell";
import { setInterested } from "./store";

/** Where the event happens: the place for external events, else the voice channel's name. */
export function useEventPlace(event: GuildScheduledEvent): { icon: "pin" | "voice"; text: string } {
  const channelName = useStore(s => (event.channel_id ? s.channels[event.channel_id]?.name ?? null : null));
  if (event.entity_type === ScheduledEventEntityType.External) return { icon: "pin", text: event.entity_metadata?.location ?? "Somewhere else" };
  return { icon: "voice", text: channelName ?? (event.channel_id ? "Voice channel" : "Channel removed") };
}

export function InterestedButton({ event, onError }: { event: GuildScheduledEvent; onError?: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const finished = event.status === ScheduledEventStatus.Completed || event.status === ScheduledEventStatus.Canceled;
  return (
    <button
      type="button"
      className={`btn btn-sm ${event.user_rsvp ? "btn-secondary cm-interested on" : "btn-secondary cm-interested"}`}
      aria-pressed={event.user_rsvp}
      disabled={busy || finished}
      onClick={e => {
        e.stopPropagation();
        setBusy(true);
        setInterested(event, !event.user_rsvp)
          .catch(error => onError?.(errorText(error)))
          .finally(() => setBusy(false));
      }}
    >
      <Star size={16} aria-hidden="true" fill={event.user_rsvp ? "currentColor" : "none"} />
      Interested
    </button>
  );
}

/** Join Stage / Join Voice while the event is live: opens the channel and joins it. */
export function JoinEventButton({ event, onJoined }: { event: GuildScheduledEvent; onJoined?: () => void }) {
  const label = joinLabel(event);
  const channel = useStore(s => (event.channel_id ? s.channels[event.channel_id] : undefined));
  if (!label || !channel) return null;
  return (
    <button
      type="button"
      className="btn btn-sm btn-success"
      onClick={e => {
        e.stopPropagation();
        go(guildPath(event.guild_id, channel.id));
        joinVoiceChannel(appStore.getState().channels[channel.id] ?? channel);
        onJoined?.();
      }}
    >
      {label}
    </button>
  );
}

/** One row of the events list. The topic opens the details (and stretches over the card); Interested toggles without opening. */
export function EventCard({ event, onOpen, onError, onJoined }: { event: GuildScheduledEvent; onOpen(): void; onError?: (message: string) => void; onJoined?: () => void }) {
  const place = useEventPlace(event);
  const locale = useChatLocale();
  const live = event.status === ScheduledEventStatus.Active;
  const cover = event.image ? resolveUrl(event.image) : null;
  return (
    <li className="cm-event-item">
      <div className="cm-event-card">
        <div className="cm-event-main">
          <div className={`cm-event-when${live ? " live" : ""}`}>
            <CalendarDays size={16} aria-hidden="true" />
            <span>{live ? statusLabel(event.status) : formatEventRange(event, undefined, locale)}</span>
          </div>
          <h3 className="cm-event-name">
            <button type="button" className="cm-event-open" onClick={onOpen}>
              {event.name}
            </button>
          </h3>
          <div className="cm-event-meta">
            <span className="cm-event-place">
              {place.icon === "pin" ? <MapPin size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
              <span>{place.text}</span>
            </span>
            <span className="cm-event-count">
              <Users size={16} aria-hidden="true" />
              <span>{event.user_count} interested</span>
            </span>
          </div>
        </div>
        {cover && <img className="cm-event-cover" src={cover} alt="" draggable={false} />}
        <div className="cm-event-actions">
          <JoinEventButton event={event} onJoined={onJoined} />
          <InterestedButton event={event} onError={onError} />
        </div>
      </div>
    </li>
  );
}
