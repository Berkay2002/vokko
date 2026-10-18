// Pure helpers of the scheduled-events UI: labels, time text, recurrence text, form validation. No React, no store.

import { RecurrenceFrequency, ScheduledEventEntityType, ScheduledEventStatus, type GuildScheduledEvent, type ScheduledEventRecurrenceRule } from "../api/types";

export const NAME_MAX = 100;
export const DESCRIPTION_MAX = 1000;
export const LOCATION_MAX = 100;

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const clock = (date: Date, locale?: string) => date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });

/** "Today at 6:00 PM", "Tomorrow at 6:00 PM" or "Tue, Oct 20 at 6:00 PM" (with the year when it is not this year). */
export function formatEventStart(iso: string, now: Date = new Date(), locale?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (sameDay(date, now)) return `Today at ${clock(date, locale)}`;
  if (sameDay(date, tomorrow)) return `Tomorrow at ${clock(date, locale)}`;
  const day = date.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
  return `${day} at ${clock(date, locale)}`;
}

/** Start, plus an end time ("– 8:00 PM", or the date again when it ends on another day). */
export function formatEventRange(event: Pick<GuildScheduledEvent, "scheduled_start_time" | "scheduled_end_time">, now: Date = new Date(), locale?: string): string {
  const start = formatEventStart(event.scheduled_start_time, now, locale);
  if (!event.scheduled_end_time) return start;
  const from = new Date(event.scheduled_start_time);
  const to = new Date(event.scheduled_end_time);
  if (Number.isNaN(to.getTime())) return start;
  return sameDay(from, to) ? `${start} – ${clock(to, locale)}` : `${start} – ${formatEventStart(event.scheduled_end_time, now, locale)}`;
}

export function statusLabel(status: ScheduledEventStatus): string {
  switch (status) {
    case ScheduledEventStatus.Active:
      return "Happening now";
    case ScheduledEventStatus.Completed:
      return "Ended";
    case ScheduledEventStatus.Canceled:
      return "Canceled";
    default:
      return "Scheduled";
  }
}

/** The join action of a live event: Join Stage for a stage event, Join Voice for a voice one; none for external or not-live events. */
export function joinLabel(event: Pick<GuildScheduledEvent, "status" | "entity_type" | "channel_id">): "Join Stage" | "Join Voice" | null {
  if (event.status !== ScheduledEventStatus.Active || !event.channel_id) return null;
  if (event.entity_type === ScheduledEventEntityType.StageInstance) return "Join Stage";
  return event.entity_type === ScheduledEventEntityType.Voice ? "Join Voice" : null;
}

export function entityLabel(type: ScheduledEventEntityType): string {
  return type === ScheduledEventEntityType.External ? "Somewhere else" : type === ScheduledEventEntityType.StageInstance ? "Stage" : "Voice channel";
}

/** "Repeats weekly on Tuesday, Friday", "Repeats every 2 days until Nov 1, 2026", "Repeats 10 times". */
export function describeRecurrence(rule: ScheduledEventRecurrenceRule | null | undefined, locale?: string): string | null {
  if (!rule) return null;
  const unit = ["year", "month", "week", "day"][rule.frequency] ?? "day";
  const adverb = ["yearly", "monthly", "weekly", "daily"][rule.frequency] ?? "daily";
  let text = rule.interval > 1 ? `Repeats every ${rule.interval} ${unit}s` : `Repeats ${adverb}`;
  if (rule.frequency === RecurrenceFrequency.Weekly && rule.by_weekday?.length) {
    text += ` on ${rule.by_weekday.map(day => WEEKDAYS[day] ?? "").filter(Boolean).join(", ")}`;
  }
  if (rule.count) text += `, ${rule.count} time${rule.count === 1 ? "" : "s"}`;
  else if (rule.end) text += ` until ${new Date(rule.end).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })}`;
  return text;
}

/** The simple repeat choices of the wizard. */
export type RepeatChoice = "none" | "daily" | "weekly" | "monthly" | "yearly";

export const REPEAT_LABELS: Record<RepeatChoice, string> = {
  none: "Does not repeat",
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
  yearly: "Every year",
};

/** weekday of a date in the contract's numbering: 0 = Monday .. 6 = Sunday. */
export const weekdayOf = (date: Date): number => (date.getDay() + 6) % 7;

export function repeatToRule(choice: RepeatChoice, start: Date): ScheduledEventRecurrenceRule | null {
  if (choice === "none") return null;
  const frequency = { daily: RecurrenceFrequency.Daily, weekly: RecurrenceFrequency.Weekly, monthly: RecurrenceFrequency.Monthly, yearly: RecurrenceFrequency.Yearly }[choice];
  return { start: start.toISOString(), end: null, frequency, interval: 1, by_weekday: choice === "weekly" ? [weekdayOf(start)] : null, count: null };
}

/** The wizard choice a stored rule maps to; null when the rule is something the wizard cannot express (kept as is on edit). */
export function ruleToRepeat(rule: ScheduledEventRecurrenceRule | null): RepeatChoice | null {
  if (!rule) return "none";
  if (rule.interval !== 1 || rule.end || rule.count) return null;
  if (rule.frequency === RecurrenceFrequency.Daily) return "daily";
  if (rule.frequency === RecurrenceFrequency.Monthly) return "monthly";
  if (rule.frequency === RecurrenceFrequency.Yearly) return "yearly";
  return rule.by_weekday && rule.by_weekday.length > 1 ? null : "weekly";
}

// ---- local date/time inputs ----

const pad = (n: number) => String(n).padStart(2, "0");

/** `<input type="date">` value of a local date. */
export const toDateInput = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
/** `<input type="time">` value of a local date. */
export const toTimeInput = (date: Date): string => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** Local date + time inputs to a Date; null when either is empty or invalid. */
export function fromInputs(date: string, time: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const result = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  return Number.isNaN(result.getTime()) ? null : result;
}

/** Next full hour from `now` plus `hours` (default start of a new event). */
export function nextHour(now: Date = new Date(), hours = 1): Date {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + hours, 0, 0, 0);
  return date;
}

export interface EventForm {
  name: string;
  description: string;
  entityType: ScheduledEventEntityType;
  channelId: string;
  location: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  repeat: RepeatChoice | "keep";
}

export type EventFormErrors = Partial<Record<"name" | "description" | "channelId" | "location" | "start" | "end", string>>;

/** The same rules the server enforces, so the wizard can explain a problem before the request. `editing`: the start may stay in the past; `channelOptional`: an event whose channel was deleted can be edited without picking one. */
export function validateEventForm(form: EventForm, now: Date = new Date(), editing = false, channelOptional = false): EventFormErrors {
  const errors: EventFormErrors = {};
  const name = form.name.trim();
  if (name.length === 0) errors.name = "Give your event a topic.";
  else if (name.length > NAME_MAX) errors.name = `The topic can be at most ${NAME_MAX} characters.`;
  if (form.description.trim().length > DESCRIPTION_MAX) errors.description = `The description can be at most ${DESCRIPTION_MAX} characters.`;
  if (form.entityType === ScheduledEventEntityType.External) {
    const place = form.location.trim();
    if (place.length === 0) errors.location = "Say where the event takes place.";
    else if (place.length > LOCATION_MAX) errors.location = `The location can be at most ${LOCATION_MAX} characters.`;
  } else if (!form.channelId && !channelOptional) {
    errors.channelId = "Pick a voice channel.";
  }
  const start = fromInputs(form.startDate, form.startTime);
  const end = fromInputs(form.endDate, form.endTime);
  if (!start) errors.start = "Pick a start date and time.";
  else if (!editing && start.getTime() <= now.getTime()) errors.start = "The event has to start in the future.";
  const hasEnd = form.endDate !== "" || form.endTime !== "";
  if (hasEnd && !end) errors.end = "Pick an end date and time, or clear both.";
  else if (end && start && end.getTime() <= start.getTime()) errors.end = "The event has to end after it starts.";
  else if (!end && form.entityType === ScheduledEventEntityType.External) errors.end = "Events somewhere else need an end time.";
  return errors;
}

export const hasErrors = (errors: EventFormErrors): boolean => Object.keys(errors).length > 0;
