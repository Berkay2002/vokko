// Client state of the community features: scheduled events per guild, kept current by the GUILD_SCHEDULED_EVENT_* gateway events.
// Onboarding and friend suggestions are fetched where they are shown and need no shared state.

import { create } from "zustand";
import { ScheduledEventStatus, type CreateScheduledEventRequest, type EditScheduledEventRequest, type GuildScheduledEvent, type Snowflake } from "../api/types";
import { appStore, gateway, request } from "./shell";

const startOf = (event: GuildScheduledEvent) => Date.parse(event.scheduled_start_time);

/** Soonest first; ties by id. Finished events are not part of a list. */
function tidy(list: GuildScheduledEvent[]): GuildScheduledEvent[] {
  return list
    .filter(event => event.status === ScheduledEventStatus.Scheduled || event.status === ScheduledEventStatus.Active)
    .sort((a, b) => startOf(a) - startOf(b) || (a.id.length === b.id.length ? (a.id < b.id ? -1 : 1) : a.id.length - b.id.length));
}

interface CommunityState {
  /** guild → scheduled and active events, soonest first. Only guilds in `loaded` are complete. */
  events: Record<Snowflake, GuildScheduledEvent[]>;
  loaded: Record<Snowflake, boolean>;
  upsert(event: GuildScheduledEvent): void;
  remove(guildId: Snowflake, eventId: Snowflake): void;
  clear(): void;
}

/**
 * Changes that arrive while a guild's first list request is in flight (event, or null for "gone"). The response may have been computed
 * before them, so they are laid over it once it lands; without this they would be dropped (the guild is not `loaded` yet).
 */
const buffered = new Map<Snowflake, Map<Snowflake, GuildScheduledEvent | null>>();

/** The fetched list with the changes that came in meanwhile applied. */
export function withBuffered(list: GuildScheduledEvent[], changes: Map<Snowflake, GuildScheduledEvent | null> | undefined): GuildScheduledEvent[] {
  if (!changes || changes.size === 0) return tidy(list);
  const merged = list.filter(event => !changes.has(event.id));
  for (const change of changes.values()) if (change) merged.push(change);
  return tidy(merged);
}

export const useCommunity = create<CommunityState>()((set, get) => ({
  events: {},
  loaded: {},
  upsert(event) {
    const state = get();
    buffered.get(event.guild_id)?.set(event.id, event);
    if (!state.loaded[event.guild_id]) return;
    const others = (state.events[event.guild_id] ?? []).filter(e => e.id !== event.id);
    set({ events: { ...state.events, [event.guild_id]: tidy([...others, event]) } });
  },
  remove(guildId, eventId) {
    const state = get();
    buffered.get(guildId)?.set(eventId, null);
    if (!state.loaded[guildId]) return;
    const list = state.events[guildId];
    if (!list?.some(e => e.id === eventId)) return;
    set({ events: { ...state.events, [guildId]: list.filter(e => e.id !== eventId) } });
  },
  clear() {
    set({ events: {}, loaded: {} });
  },
}));

const inflight = new Map<Snowflake, Promise<void>>();

/** Fetches the guild's open events once (concurrent calls share the request). `force` refetches. */
export function loadEvents(guildId: Snowflake, force = false): Promise<void> {
  if (!force && useCommunity.getState().loaded[guildId]) return Promise.resolve();
  const pending = inflight.get(guildId);
  if (pending) return pending;
  buffered.set(guildId, new Map());
  const run = request<GuildScheduledEvent[]>("GET", `/guilds/${guildId}/scheduled-events?with_user_count=true`)
    .then(list => {
      const state = useCommunity.getState();
      useCommunity.setState({ events: { ...state.events, [guildId]: withBuffered(list, buffered.get(guildId)) }, loaded: { ...state.loaded, [guildId]: true } });
    })
    .finally(() => {
      buffered.delete(guildId);
      inflight.delete(guildId);
    });
  inflight.set(guildId, run);
  return run;
}

export const createEvent = async (guildId: Snowflake, body: CreateScheduledEventRequest): Promise<GuildScheduledEvent> => {
  const event = await request<GuildScheduledEvent>("POST", `/guilds/${guildId}/scheduled-events`, body);
  useCommunity.getState().upsert(event);
  return event;
};

export const editEvent = async (guildId: Snowflake, eventId: Snowflake, body: EditScheduledEventRequest): Promise<GuildScheduledEvent> => {
  const event = await request<GuildScheduledEvent>("PATCH", `/guilds/${guildId}/scheduled-events/${eventId}`, body);
  if (event.status === ScheduledEventStatus.Completed || event.status === ScheduledEventStatus.Canceled) useCommunity.getState().remove(guildId, eventId);
  else useCommunity.getState().upsert(event);
  return event;
};

export const deleteEvent = async (guildId: Snowflake, eventId: Snowflake): Promise<void> => {
  await request<void>("DELETE", `/guilds/${guildId}/scheduled-events/${eventId}`);
  useCommunity.getState().remove(guildId, eventId);
};

/** Marks (or unmarks) the viewer as Interested; the list updates at once, the gateway echo changes nothing a second time. */
export async function setInterested(event: GuildScheduledEvent, interested: boolean): Promise<void> {
  if (event.user_rsvp === interested) return;
  const store = useCommunity.getState();
  store.upsert({ ...event, user_rsvp: interested, user_count: Math.max(0, event.user_count + (interested ? 1 : -1)) });
  try {
    await request<void>(interested ? "PUT" : "DELETE", `/guilds/${event.guild_id}/scheduled-events/${event.id}/users/@me`);
  } catch (error) {
    store.upsert(event);
    throw error;
  }
}

export const eventOf = (guildId: Snowflake, eventId: Snowflake): GuildScheduledEvent | undefined => useCommunity.getState().events[guildId]?.find(e => e.id === eventId);

let wired = false;
/** Called once from `index.ts`. */
export function wireCommunityToGateway(): void {
  if (wired) return;
  wired = true;
  gateway.on("READY", () => useCommunity.getState().clear());
  gateway.on("GUILD_DELETE", ({ id }) => {
    const { events, loaded } = useCommunity.getState();
    const { [id]: _events, ...restEvents } = events;
    const { [id]: _loaded, ...restLoaded } = loaded;
    void _events;
    void _loaded;
    useCommunity.setState({ events: restEvents, loaded: restLoaded });
  });
  const changed = (event: GuildScheduledEvent) => {
    const store = useCommunity.getState();
    if (event.status === ScheduledEventStatus.Completed || event.status === ScheduledEventStatus.Canceled) store.remove(event.guild_id, event.id);
    else store.upsert(event);
  };
  gateway.on("GUILD_SCHEDULED_EVENT_CREATE", changed);
  gateway.on("GUILD_SCHEDULED_EVENT_UPDATE", changed);
  gateway.on("GUILD_SCHEDULED_EVENT_DELETE", event => useCommunity.getState().remove(event.guild_id, event.id));
  const adjust = (guildId: Snowflake, eventId: Snowflake, userId: Snowflake, joined: boolean) => {
    const event = eventOf(guildId, eventId);
    if (!event) return;
    const mine = appStore.getState().me?.id === userId;
    // Our own toggle is applied optimistically already.
    if (mine && event.user_rsvp === joined) return;
    useCommunity.getState().upsert({ ...event, user_count: Math.max(0, event.user_count + (joined ? 1 : -1)), user_rsvp: mine ? joined : event.user_rsvp });
  };
  gateway.on("GUILD_SCHEDULED_EVENT_USER_ADD", d => adjust(d.guild_id, d.guild_scheduled_event_id, d.user_id, true));
  gateway.on("GUILD_SCHEDULED_EVENT_USER_REMOVE", d => adjust(d.guild_id, d.guild_scheduled_event_id, d.user_id, false));
}
