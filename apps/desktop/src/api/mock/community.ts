// Mock of the community routes in docs/api.md: scheduled events, onboarding and friend suggestions. Same status codes, error
// codes and gateway events as the server; the validation is the same set of rules (see crates/server/src/routes/*).

import {
  ChannelType,
  MemberFlags,
  OnboardingMode,
  OnboardingPromptType,
  RelationshipType,
  ScheduledEventEntityType,
  ScheduledEventStatus,
  type FriendSuggestion,
  type GatewayEvents,
  type GuildMember,
  type GuildOnboarding,
  type GuildScheduledEvent,
  type OnboardingOption,
  type OnboardingPrompt,
  type ScheduledEventRecurrenceRule,
} from "../types";
import { compareIds } from "../snowflake";
import { Perm, hasBit } from "../permissions";
import { channelPermsOf, guildPermsOf } from "./access";
import { db, nextId, userOf, type MockGuild } from "./db";
import { addMemberFlags, addedByOnboarding, flagsField, getMemberFlags } from "./memberFlags";
import { addChannel, createAccount, createGuildRecord, fail, pendingAttachment, requireChannel, requireGuildMember, requireGuildPerm } from "./ops";
import { memberProfileFields } from "./perks";
import { ID, route, str } from "./router";
import { emit } from "./socket";
import { mutualFriendsOf } from "./mutualFriends";
import { createStage, endStage, isStageModerator, stageInstances } from "./voice";

function invalid(field: string, message: string): never {
  return fail(400, 50035, "Invalid Form Body", { [field]: { code: "INVALID", message } });
}
const bool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);

// ---- scheduled events ----

interface MockEvent extends Omit<GuildScheduledEvent, "user_count" | "user_rsvp" | "creator"> {
  interested: Set<string>;
}

const events = new Map<string, MockEvent>();
const MAX_OPEN_EVENTS = 100;

const isFinished = (status: ScheduledEventStatus) => status === ScheduledEventStatus.Completed || status === ScheduledEventStatus.Canceled;

/** Interested members that are still in the guild. */
const interestedNow = (event: MockEvent): string[] => {
  const guild = db.guilds.get(event.guild_id);
  return [...event.interested].filter(id => guild?.members.has(id));
};

function view(event: MockEvent, viewerId: string): GuildScheduledEvent {
  const { interested, ...rest } = event;
  void interested;
  const creator = event.creator_id && db.accounts.has(event.creator_id) ? { creator: userOf(event.creator_id) } : {};
  return {
    ...rest,
    ...creator,
    entity_metadata: rest.entity_metadata ? { ...rest.entity_metadata } : null,
    recurrence_rule: rest.recurrence_rule ? { ...rest.recurrence_rule, by_weekday: rest.recurrence_rule.by_weekday ? [...rest.recurrence_rule.by_weekday] : null } : null,
    user_count: interestedNow(event).length,
    user_rsvp: event.interested.has(viewerId) && !!db.guilds.get(event.guild_id)?.members.has(viewerId),
  };
}

/**
 * Who sees an event: everyone for external events; those who can view the channel for channel events; for a voice event whose channel
 * is gone, its creator and people with MANAGE_EVENTS.
 */
function canSee(event: MockEvent, userId: string): boolean {
  if (!db.guilds.get(event.guild_id)?.members.has(userId)) return false;
  if (event.entity_type === ScheduledEventEntityType.External) return true;
  const channel = event.channel_id ? db.channels.get(event.channel_id) : undefined;
  if (channel) return hasBit(channelPermsOf(channel, userId), Perm.VIEW_CHANNEL);
  return event.creator_id === userId || hasBit(guildPermsOf(event.guild_id, userId), Perm.MANAGE_EVENTS);
}

const viewersOf = (event: MockEvent): string[] => [...(db.guilds.get(event.guild_id)?.members.keys() ?? [])].filter(id => canSee(event, id));

type EventName = "GUILD_SCHEDULED_EVENT_CREATE" | "GUILD_SCHEDULED_EVENT_UPDATE" | "GUILD_SCHEDULED_EVENT_DELETE";

function broadcast(event: MockEvent, name: EventName, to: string[] = viewersOf(event)): void {
  for (const id of to) emit([id], name, view(event, id));
}

function parseTime(value: unknown, field: string): number {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) invalid(field, "Must be an ISO 8601 timestamp.");
  return ms;
}

function checkRecurrence(value: unknown): ScheduledEventRecurrenceRule | null {
  if (value === null || value === undefined) return null;
  const rule = value as Partial<ScheduledEventRecurrenceRule>;
  const start = parseTime(rule.start, "recurrence_rule.start");
  if (rule.end != null && parseTime(rule.end, "recurrence_rule.end") <= start) invalid("recurrence_rule.end", "Must be after the start.");
  if (![0, 1, 2, 3].includes(rule.frequency as number)) invalid("recurrence_rule.frequency", "Unknown frequency.");
  if (!Number.isInteger(rule.interval) || (rule.interval as number) < 1 || (rule.interval as number) > 12) invalid("recurrence_rule.interval", "Must be between 1 and 12.");
  if (rule.count != null && (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > 1000)) invalid("recurrence_rule.count", "Must be between 1 and 1000.");
  let weekdays: number[] | null = null;
  if (rule.by_weekday != null) {
    if (rule.frequency !== 2) invalid("recurrence_rule.by_weekday", "Only weekly rules take weekdays.");
    weekdays = [...new Set(rule.by_weekday)].sort((a, b) => a - b);
    if (weekdays.length === 0 || weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) invalid("recurrence_rule.by_weekday", "Use 0 (Monday) to 6 (Sunday).");
  }
  return { start: rule.start as string, end: rule.end ?? null, frequency: rule.frequency!, interval: rule.interval!, by_weekday: weekdays, count: rule.count ?? null };
}

function textField(value: unknown, field: string, max: number, required = false): string | null {
  if (value === null || value === undefined) return required ? invalid(field, "Required.") : null;
  if (typeof value !== "string") return invalid(field, "Not a string.");
  const trimmed = value.trim();
  if (trimmed.length > max) invalid(field, `Must be ${max} or fewer in length.`);
  if (required && trimmed === "") invalid(field, `Must be between 1 and ${max} in length.`);
  return trimmed === "" ? null : trimmed;
}

interface Resolved {
  name: string;
  description: string | null;
  entity_type: ScheduledEventEntityType;
  channel_id: string | null;
  location: string | null;
  start: number;
  end: number | null;
}

function checkEntity(guildId: string, viewerId: string, r: Resolved, checkChannel: boolean, requireChannelPick: boolean): void {
  if (r.entity_type === ScheduledEventEntityType.External) {
    if (r.channel_id) invalid("channel_id", "External events have no channel.");
    if (!r.location) invalid("entity_metadata.location", "External events need a location.");
    if (r.end === null) invalid("scheduled_end_time", "External events need an end time.");
  } else {
    // An event whose channel was deleted can still be edited; only picking or changing the entity needs a channel.
    if (!r.channel_id && requireChannelPick) invalid("channel_id", "Voice events need a voice channel.");
    if (checkChannel && r.channel_id) {
      const channel = db.channels.get(r.channel_id);
      const stage = r.entity_type === ScheduledEventEntityType.StageInstance;
      if (!channel || channel.guild_id !== guildId || channel.type !== (stage ? ChannelType.GuildStage : ChannelType.GuildVoice))
        invalid("channel_id", stage ? "Must be a stage channel of this guild." : "Must be a voice channel of this guild.");
      requireChannel(channel!.id, viewerId);
      if (!hasBit(channelPermsOf(channel!, viewerId), Perm.CONNECT)) fail(403, 50013, "Missing Permissions");
    }
  }
  if (r.end !== null && r.end <= r.start) invalid("scheduled_end_time", "Must be after the start.");
}

function entityTypeOf(value: unknown): ScheduledEventEntityType {
  if (value !== 1 && value !== 2 && value !== 3) return invalid("entity_type", "Unknown entity type.");
  return value;
}

function locationOf(meta: unknown): string | null {
  if (meta === null || meta === undefined) return null;
  const location = (meta as { location?: unknown }).location;
  return textField(location, "entity_metadata.location", 100);
}

function coverUrl(value: unknown, viewerId: string): string | null {
  if (value === null || value === undefined) return null;
  return pendingAttachment(str(value), viewerId)?.url ?? null;
}

/** The event, or 10065 when it does not exist or is hidden from the viewer. */
function requireEvent(guildId: string, eventId: string, viewerId: string): MockEvent {
  const event = events.get(eventId);
  if (!event || event.guild_id !== guildId || !canSee(event, viewerId)) fail(404, 10065, "Unknown Guild Scheduled Event");
  return event;
}

const canManageEvent = (guildId: string, viewerId: string, event: MockEvent): boolean => {
  const perms = guildPermsOf(guildId, viewerId);
  return hasBit(perms, Perm.MANAGE_EVENTS) || (hasBit(perms, Perm.CREATE_EVENTS) && event.creator_id === viewerId);
};

route("GET", `/guilds/${ID}/scheduled-events`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  return [...events.values()]
    .filter(e => e.guild_id === guildId && (e.status === ScheduledEventStatus.Scheduled || e.status === ScheduledEventStatus.Active) && canSee(e, viewer.user.id))
    .sort((a, b) => Date.parse(a.scheduled_start_time) - Date.parse(b.scheduled_start_time) || compareIds(a.id, b.id))
    .map(e => view(e, viewer.user.id));
});

route("POST", `/guilds/${ID}/scheduled-events`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  const perms = guildPermsOf(guildId, viewer.user.id);
  if (!hasBit(perms, Perm.CREATE_EVENTS) && !hasBit(perms, Perm.MANAGE_EVENTS)) fail(403, 50013, "Missing Permissions");
  if (body.privacy_level !== undefined && body.privacy_level !== null && body.privacy_level !== 2) invalid("privacy_level", "Only 2 (guild only) is supported.");
  const entity_type = entityTypeOf(body.entity_type);
  const start = parseTime(body.scheduled_start_time, "scheduled_start_time");
  if (start <= Date.now()) invalid("scheduled_start_time", "Must be in the future.");
  const resolved: Resolved = {
    name: textField(body.name, "name", 100, true)!,
    description: textField(body.description, "description", 1000),
    entity_type,
    channel_id: str(body.channel_id) ?? null,
    location: entity_type === ScheduledEventEntityType.External ? locationOf(body.entity_metadata) : null,
    start,
    end: body.scheduled_end_time ? parseTime(body.scheduled_end_time, "scheduled_end_time") : null,
  };
  const recurrence = checkRecurrence(body.recurrence_rule);
  checkEntity(guildId, viewer.user.id, resolved, true, true);
  const open = [...events.values()].filter(e => e.guild_id === guildId && !isFinished(e.status)).length;
  if (open >= MAX_OPEN_EVENTS) fail(400, 30038, "Maximum number of scheduled events reached");
  const event: MockEvent = {
    id: nextId(),
    guild_id: guildId,
    channel_id: resolved.channel_id,
    creator_id: viewer.user.id,
    name: resolved.name,
    description: resolved.description,
    scheduled_start_time: new Date(start).toISOString(),
    scheduled_end_time: resolved.end === null ? null : new Date(resolved.end).toISOString(),
    privacy_level: 2,
    status: ScheduledEventStatus.Scheduled,
    entity_type,
    entity_id: null,
    entity_metadata: entity_type === ScheduledEventEntityType.External ? { location: resolved.location } : null,
    image: coverUrl(body.image_attachment_id, viewer.user.id),
    recurrence_rule: recurrence,
    interested: new Set(),
  };
  events.set(event.id, event);
  broadcast(event, "GUILD_SCHEDULED_EVENT_CREATE");
  return view(event, viewer.user.id);
});

route("GET", `/guilds/${ID}/scheduled-events/${ID}`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  return view(requireEvent(guildId, params[1] ?? "", viewer.user.id), viewer.user.id);
});

const TRANSITIONS: [ScheduledEventStatus, ScheduledEventStatus][] = [
  [ScheduledEventStatus.Scheduled, ScheduledEventStatus.Active],
  [ScheduledEventStatus.Scheduled, ScheduledEventStatus.Canceled],
  [ScheduledEventStatus.Active, ScheduledEventStatus.Completed],
];

route("PATCH", `/guilds/${ID}/scheduled-events/${ID}`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  const event = requireEvent(guildId, params[1] ?? "", viewer.user.id);
  if (!canManageEvent(guildId, viewer.user.id, event)) fail(403, 50013, "Missing Permissions");
  if (isFinished(event.status)) fail(400, 180000, "Cannot update a finished event");
  let status: ScheduledEventStatus | null = null;
  if (body.status !== undefined && body.status !== event.status) {
    const next = body.status as ScheduledEventStatus;
    if (!TRANSITIONS.some(([from, to]) => from === event.status && to === next)) invalid("status", "That status change is not allowed.");
    status = next;
    // A status change acts on the channel: the caller must still be able to connect; an event without a channel cannot be started.
    if (event.entity_type !== ScheduledEventEntityType.External) {
      const channel = event.channel_id ? db.channels.get(event.channel_id) : undefined;
      if (channel) {
        if (!hasBit(channelPermsOf(channel, viewer.user.id), Perm.CONNECT)) fail(403, 50013, "Missing Permissions");
      } else if (next === ScheduledEventStatus.Active) invalid("channel_id", "Pick a voice channel before starting this event.");
    }
  }
  if (event.status === ScheduledEventStatus.Active) {
    for (const field of ["entity_type", "channel_id", "entity_metadata", "scheduled_start_time", "recurrence_rule"]) if (field in body) invalid(field, "Cannot change this once the event started.");
  }
  const entity_type = "entity_type" in body ? entityTypeOf(body.entity_type) : event.entity_type;
  const external = entity_type === ScheduledEventEntityType.External;
  const startMs = "scheduled_start_time" in body ? parseTime(body.scheduled_start_time, "scheduled_start_time") : Date.parse(event.scheduled_start_time);
  if ("scheduled_start_time" in body && startMs !== Date.parse(event.scheduled_start_time) && startMs <= Date.now()) invalid("scheduled_start_time", "Must be in the future.");
  if (status === ScheduledEventStatus.Active && startMs !== Date.parse(event.scheduled_start_time)) invalid("scheduled_start_time", "Start the event or move it, not both at once.");
  const resolved: Resolved = {
    name: "name" in body ? textField(body.name, "name", 100, true)! : event.name,
    description: "description" in body ? textField(body.description, "description", 1000) : event.description,
    entity_type,
    channel_id: "channel_id" in body ? (str(body.channel_id) ?? null) : external ? null : event.channel_id,
    location: external ? ("entity_metadata" in body ? locationOf(body.entity_metadata) : event.entity_metadata?.location ?? null) : null,
    start: startMs,
    end: "scheduled_end_time" in body ? (body.scheduled_end_time ? parseTime(body.scheduled_end_time, "scheduled_end_time") : null) : event.scheduled_end_time ? Date.parse(event.scheduled_end_time) : null,
  };
  const recurrence = "recurrence_rule" in body ? checkRecurrence(body.recurrence_rule) : event.recurrence_rule;
  const touched = "entity_type" in body || "channel_id" in body;
  checkEntity(guildId, viewer.user.id, resolved, touched, touched);
  const image = "image_attachment_id" in body ? coverUrl(body.image_attachment_id, viewer.user.id) : event.image;
  // A stage event owns the stage while it is live: starting opens it (needs stage moderator; one already open is kept), completing ends it.
  const stageId = entity_type === ScheduledEventEntityType.StageInstance ? resolved.channel_id : null;
  if (stageId && status === ScheduledEventStatus.Active && !stageInstances.has(stageId)) createStage(viewer.user.id, { channel_id: stageId, topic: resolved.name }, emit);
  if (stageId && status === ScheduledEventStatus.Completed) {
    const channel = db.channels.get(stageId);
    if (channel && !isStageModerator(channel, viewer.user.id)) fail(403, 50013, "Missing Permissions");
    endStage(stageId, emit);
  }
  const before = { ...event, interested: new Set(event.interested) };
  const viewersBefore = viewersOf(event);
  Object.assign(event, {
    name: resolved.name,
    description: resolved.description,
    entity_type,
    channel_id: resolved.channel_id,
    entity_metadata: external ? { location: resolved.location } : null,
    scheduled_start_time: new Date(resolved.start).toISOString(),
    scheduled_end_time: resolved.end === null ? null : new Date(resolved.end).toISOString(),
    image,
    recurrence_rule: recurrence,
    ...(status === null ? {} : { status }),
  });
  const last = { ...before, interested: new Set(before.interested) };
  const seenBefore = viewersBefore;
  const now = viewersOf(event);
  broadcast(last, "GUILD_SCHEDULED_EVENT_DELETE", seenBefore.filter(id => !now.includes(id)));
  broadcast(event, "GUILD_SCHEDULED_EVENT_UPDATE", now);
  return view(event, viewer.user.id);
});

route("DELETE", `/guilds/${ID}/scheduled-events/${ID}`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  const event = requireEvent(guildId, params[1] ?? "", viewer.user.id);
  if (!canManageEvent(guildId, viewer.user.id, event)) fail(403, 50013, "Missing Permissions");
  broadcast(event, "GUILD_SCHEDULED_EVENT_DELETE");
  events.delete(event.id);
  return undefined;
});

route("GET", `/guilds/${ID}/scheduled-events/${ID}/users`, ({ viewer, params, query }) => {
  const guildId = params[0] ?? "";
  const guild = requireGuildMember(guildId, viewer.user.id);
  const event = requireEvent(guildId, params[1] ?? "", viewer.user.id);
  const limit = query.get("limit") === null ? 100 : Number(query.get("limit"));
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid("limit", "Must be between 1 and 100.");
  const after = query.get("after");
  return interestedNow(event)
    .sort(compareIds)
    .filter(id => (after ? compareIds(id, after) > 0 : true))
    .slice(0, limit)
    .map(id => {
      const record = guild.members.get(id);
      const member: GuildMember | undefined =
        query.get("with_member") === "true" && record
          ? { user: userOf(id), nick: record.nick, roles: [...record.roles], joined_at: record.joined_at, ...memberProfileFields(record), ...flagsField(guildId, id) }
          : undefined;
      return { guild_scheduled_event_id: event.id, user: userOf(id), ...(member ? { member } : {}) };
    });
});

function userEvent(guildId: string, eventId: string, userId: string): GatewayEvents["GUILD_SCHEDULED_EVENT_USER_ADD"] {
  return { guild_scheduled_event_id: eventId, user_id: userId, guild_id: guildId };
}

route("PUT", `/guilds/${ID}/scheduled-events/${ID}/users/@me`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  const event = requireEvent(guildId, params[1] ?? "", viewer.user.id);
  if (isFinished(event.status)) fail(400, 180000, "Cannot update a finished event");
  if (!event.interested.has(viewer.user.id)) {
    event.interested.add(viewer.user.id);
    emit(viewersOf(event), "GUILD_SCHEDULED_EVENT_USER_ADD", userEvent(guildId, event.id, viewer.user.id));
  }
  return undefined;
});

route("DELETE", `/guilds/${ID}/scheduled-events/${ID}/users/@me`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  const event = requireEvent(guildId, params[1] ?? "", viewer.user.id);
  if (event.interested.delete(viewer.user.id)) emit(viewersOf(event), "GUILD_SCHEDULED_EVENT_USER_REMOVE", userEvent(guildId, event.id, viewer.user.id));
  return undefined;
});

/**
 * Channel about to be deleted (called by the DELETE /channels route): events pointing at it lose the channel. People who saw them
 * only through the channel hear they are gone, the rest get the update.
 */
export function eventsChannelRemoved(channelId: string): void {
  for (const event of events.values()) {
    if (event.channel_id !== channelId) continue;
    const before = viewersOf(event);
    const last = { ...event, interested: new Set(event.interested) };
    event.channel_id = null;
    const after = viewersOf(event);
    broadcast(last, "GUILD_SCHEDULED_EVENT_DELETE", before.filter(id => !after.includes(id)));
    broadcast(event, "GUILD_SCHEDULED_EVENT_UPDATE", after);
  }
}

// ---- onboarding ----

interface MockOnboarding {
  enabled: boolean;
  mode: OnboardingMode;
  default_channel_ids: string[];
  rules: GuildOnboarding["rules"];
  /** When the rules appeared (ms): only members who joined after it are held until they accept (server: `rules_since`). */
  rules_since: number | null;
  prompts: OnboardingPrompt[];
}

const onboardings = new Map<string, MockOnboarding>();
/** guild → user → option ids */
const answers = new Map<string, Map<string, Set<string>>>();

const emptyOnboarding = (): MockOnboarding => ({ enabled: false, mode: OnboardingMode.Default, default_channel_ids: [], rules: null, rules_since: null, prompts: [] });
const configOf = (guildId: string): MockOnboarding => onboardings.get(guildId) ?? emptyOnboarding();

function onboardingView(guildId: string): GuildOnboarding {
  const config = configOf(guildId);
  const channelOk = (id: string) => {
    const channel = db.channels.get(id);
    return channel?.guild_id === guildId && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildVoice);
  };
  const roleOk = (id: string) => id !== guildId && !!db.guilds.get(guildId)?.guild.roles.some(r => r.id === id);
  return {
    guild_id: guildId,
    enabled: config.enabled,
    mode: config.mode,
    default_channel_ids: config.default_channel_ids.filter(channelOk),
    rules: config.rules ? { description: config.rules.description, items: [...config.rules.items] } : null,
    prompts: config.prompts.map(prompt => ({
      ...prompt,
      options: prompt.options.map(option => ({ ...option, channel_ids: option.channel_ids.filter(channelOk), role_ids: option.role_ids.filter(roleOk) })),
    })),
  };
}

route("GET", `/guilds/${ID}/onboarding`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  const config = { ...onboardingView(guildId), rules_pending: rulesPending(guildId, viewer.user.id) };
  // Channels the member cannot view are not theirs to learn about; editors (MANAGE_GUILD) see everything.
  if (hasBit(guildPermsOf(guildId, viewer.user.id), Perm.MANAGE_GUILD)) return config;
  const viewable = (id: string) => {
    const channel = db.channels.get(id);
    return !!channel && hasBit(channelPermsOf(channel, viewer.user.id), Perm.VIEW_CHANNEL);
  };
  return {
    ...config,
    default_channel_ids: config.default_channel_ids.filter(viewable),
    prompts: config.prompts.map(prompt => ({ ...prompt, options: prompt.options.map(option => ({ ...option, channel_ids: option.channel_ids.filter(viewable) })) })),
  };
});

const roleRank = (guild: MockGuild, id: string): number => guild.guild.roles.find(r => r.id === id)?.position ?? 0;

route("PUT", `/guilds/${ID}/onboarding`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  const guild = requireGuildPerm(guildId, viewer.user.id, Perm.MANAGE_GUILD | Perm.MANAGE_ROLES);
  const current = onboardingView(guildId);
  const channelIds = new Set([...db.channels.values()].filter(c => c.guild_id === guildId && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice)).map(c => c.id));
  const roleIds = new Set(guild.guild.roles.filter(r => r.id !== guildId).map(r => r.id));
  const owner = guild.guild.owner_id === viewer.user.id;
  const mine = guild.members.get(viewer.user.id)?.roles ?? [];
  const top = Math.max(-1, ...mine.map(id => roleRank(guild, id)));
  const grantable = (id: string) => owner || roleRank(guild, id) < top;
  const existingOptions = new Map<string, { prompt: string; roles: string[] }>();
  for (const prompt of configOf(guildId).prompts) for (const option of prompt.options) existingOptions.set(option.id, { prompt: prompt.id, roles: option.role_ids });
  const existingPrompts = new Set(current.prompts.map(p => p.id));

  let prompts: OnboardingPrompt[] | null = null;
  if (body.prompts !== undefined) {
    if (!Array.isArray(body.prompts) || body.prompts.length > 15) invalid("prompts", "At most 15 prompts.");
    const used = new Set<string>();
    prompts = (body.prompts as Record<string, unknown>[]).map((raw, index) => {
      const field = `prompts[${index}]`;
      const options = Array.isArray(raw.options) ? (raw.options as Record<string, unknown>[]) : [];
      if (options.length < 1 || options.length > 50) invalid(`${field}.options`, "Needs between 1 and 50 options.");
      const keptId = str(raw.id) && existingPrompts.has(str(raw.id)!) ? str(raw.id)! : null;
      const id = keptId ?? nextId();
      if (used.has(id)) invalid("prompts", "Duplicate prompt.");
      used.add(id);
      const usedOptions = new Set<string>();
      return {
        id,
        type: raw.type === OnboardingPromptType.Dropdown ? OnboardingPromptType.Dropdown : OnboardingPromptType.MultipleChoice,
        title: textField(raw.title, `${field}.title`, 100, true)!,
        single_select: bool(raw.single_select) ?? false,
        required: bool(raw.required) ?? false,
        in_onboarding: bool(raw.in_onboarding) ?? true,
        options: options.map((o): OnboardingOption => {
          const optField = `${field}.options`;
          const existing = str(o.id) ? existingOptions.get(str(o.id)!) : undefined;
          const optionId = existing && existing.prompt === keptId ? str(o.id)! : nextId();
          if (usedOptions.has(optionId)) invalid(optField, "Duplicate option.");
          usedOptions.add(optionId);
          const channel_ids = [...new Set((Array.isArray(o.channel_ids) ? o.channel_ids : []) as string[])];
          const role_ids = [...new Set((Array.isArray(o.role_ids) ? o.role_ids : []) as string[])];
          if (channel_ids.length > 25 || role_ids.length > 25) invalid(optField, "Too many channels or roles.");
          if (channel_ids.some(c => !channelIds.has(c))) invalid(optField, "Unknown channel.");
          for (const role of role_ids) {
            if (!roleIds.has(role)) invalid(optField, "Unknown role.");
            if (!grantable(role) && !(existing?.prompt === keptId && existing?.roles.includes(role))) fail(403, 50013, "Missing Permissions");
          }
          const emoji = o.emoji as { id?: string | null; name?: string } | null | undefined;
          if (emoji && (typeof emoji.name !== "string" || emoji.name.trim() === "" || emoji.name.length > 64)) invalid(optField, "Invalid emoji.");
          return {
            id: optionId,
            title: textField(o.title, `${field}.options.title`, 50, true)!,
            description: textField(o.description, `${field}.options.description`, 100),
            emoji: emoji ? { id: emoji.id ?? null, name: emoji.name!.trim() } : null,
            channel_ids,
            role_ids,
          };
        }),
      };
    });
  }
  let defaults = current.default_channel_ids;
  if (body.default_channel_ids !== undefined) {
    const ids = [...new Set(Array.isArray(body.default_channel_ids) ? (body.default_channel_ids as string[]) : [])];
    if (ids.length > 50 || ids.some(id => !channelIds.has(id))) invalid("default_channel_ids", "Up to 50 channels of this guild.");
    defaults = ids;
  }
  let rules = current.rules;
  if ("rules" in body) {
    if (body.rules === null) rules = null;
    else {
      const raw = body.rules as { description?: unknown; items?: unknown };
      const items = Array.isArray(raw.items) ? raw.items : [];
      if (items.length < 1 || items.length > 16) invalid("rules.items", "Needs between 1 and 16 rules.");
      rules = { description: textField(raw.description, "rules.description", 300), items: items.map(item => textField(item, "rules.items", 300, true)!) };
    }
  }
  const mode = body.mode === OnboardingMode.Advanced ? OnboardingMode.Advanced : body.mode === OnboardingMode.Default ? OnboardingMode.Default : current.mode;
  const rulesSince = !rules ? null : configOf(guildId).rules ? configOf(guildId).rules_since : Date.now();
  onboardings.set(guildId, { enabled: bool(body.enabled) ?? current.enabled, mode, default_channel_ids: defaults, rules, rules_since: rulesSince, prompts: prompts ?? current.prompts });
  return onboardingView(guildId);
});

route("GET", `/guilds/${ID}/onboarding-responses`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  return { option_ids: [...(answers.get(guildId)?.get(viewer.user.id) ?? [])].sort(compareIds) };
});

route("PUT", `/guilds/${ID}/onboarding-responses`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  const guild = requireGuildMember(guildId, viewer.user.id);
  const config = onboardingView(guildId);
  if (!config.enabled) invalid("guild", "Onboarding is not enabled.");
  const chosen = [...new Set(Array.isArray(body.option_ids) ? (body.option_ids as string[]) : [])];
  const known = new Map<string, { prompt: OnboardingPrompt; option: OnboardingOption }>();
  for (const prompt of config.prompts) for (const option of prompt.options) known.set(option.id, { prompt, option });
  if (chosen.some(id => !known.has(id))) invalid("option_ids", "Unknown option.");
  for (const prompt of config.prompts) {
    const picked = prompt.options.filter(o => chosen.includes(o.id)).length;
    if (prompt.single_select && picked > 1) invalid("option_ids", "That question takes one answer.");
    if (prompt.required && prompt.in_onboarding && picked === 0) invalid("option_ids", "Answer every required question.");
  }
  if (config.rules && body.rules_accepted !== true) invalid("rules_accepted", "Accept the rules to continue.");

  const userId = viewer.user.id;
  const record = guild.members.get(userId)!;
  const granted = new Set(chosen.flatMap(id => known.get(id)!.option.role_ids));
  const earlier = addedByOnboarding.get(guildId)?.get(userId) ?? new Set<string>();
  const dropped = new Set([...earlier].filter(role => !granted.has(role)));
  const added = [...granted].filter(role => !record.roles.includes(role));
  record.roles = [...record.roles.filter(r => !dropped.has(r)), ...added];
  const byUser = addedByOnboarding.get(guildId) ?? new Map<string, Set<string>>();
  byUser.set(userId, new Set([...earlier].filter(role => granted.has(role)).concat(added)));
  addedByOnboarding.set(guildId, byUser);
  const byGuild = answers.get(guildId) ?? new Map<string, Set<string>>();
  byGuild.set(userId, new Set(chosen));
  answers.set(guildId, byGuild);
  addMemberFlags(guildId, userId, MemberFlags.CompletedOnboarding);

  const member = memberOf(guildId, userId);
  emit(guild.members.keys(), "GUILD_MEMBER_UPDATE", { ...member, guild_id: guildId });
  // Default mode lands the member in the default channels only; Advanced adds the channels of the chosen options.
  const fromAnswers = config.mode === OnboardingMode.Advanced ? chosen.flatMap(id => known.get(id)!.option.channel_ids) : [];
  const wanted = [...new Set([...config.default_channel_ids, ...fromAnswers])];
  const channel_ids = wanted.filter(id => {
    const channel = db.channels.get(id);
    return !!channel && hasBit(channelPermsOf(channel, userId), Perm.VIEW_CHANNEL);
  });
  return { member, channel_ids };
});

function memberOf(guildId: string, userId: string): GuildMember {
  const record = db.guilds.get(guildId)!.members.get(userId)!;
  return {
    user: userOf(userId),
    nick: record.nick,
    roles: [...record.roles],
    joined_at: record.joined_at,
    ...(record.communication_disabled_until ? { communication_disabled_until: record.communication_disabled_until } : {}),
    ...memberProfileFields(record),
    ...flagsField(guildId, userId),
  };
}

/** The member is held by the rules gate (same conditions and exemptions as the server's `rules_pending`). */
function rulesPending(guildId: string | null | undefined, userId: string): boolean {
  const guild = guildId ? db.guilds.get(guildId) : undefined;
  const record = guild?.members.get(userId);
  const config = guildId ? onboardings.get(guildId) : undefined;
  if (!guildId || !guild || !record || !config?.enabled || !config.rules || config.rules_since === null) return false;
  const flags = getMemberFlags(guildId, userId);
  const held = (flags & MemberFlags.StartedOnboarding) !== 0 && (flags & MemberFlags.CompletedOnboarding) === 0 && Date.parse(record.joined_at) >= config.rules_since;
  return held && guild.guild.owner_id !== userId && !userOf(userId).bot && !hasBit(guildPermsOf(guildId, userId), Perm.ADMINISTRATOR);
}

/** 403 150010 while the member still has to accept the guild's rules. */
export function checkRulesAccepted(guildId: string | null | undefined, userId: string): void {
  if (rulesPending(guildId, userId)) fail(403, 150010, "Accept the server rules to talk here");
}

/** A member joined through an invite: guilds with onboarding switched on start them in the flow. */
export function onboardingStartedFor(guildId: string, userId: string): void {
  if (onboardings.get(guildId)?.enabled) addMemberFlags(guildId, userId, MemberFlags.StartedOnboarding);
}

// ---- friend suggestions ----

const SMALL_GUILD_MEMBERS = 200;
const optedOut = new Set<string>();
/** Seed filler accounts (the members-page demo crowd) stay out of everyone's friend suggestions. */
export function hideFromSuggestions(ids: Iterable<string>): void {
  for (const id of ids) optedOut.add(id);
}
/** user → people they hid */
const dismissed = new Map<string, Set<string>>();

const relationBetween = (a: string, b: string): boolean => db.accounts.get(a)?.relationships.has(b) === true || db.accounts.get(b)?.relationships.has(a) === true;

function friendsOf(userId: string): Set<string> {
  const out = new Set<string>();
  for (const [id, type] of db.accounts.get(userId)?.relationships ?? []) if (type === RelationshipType.Friend) out.add(id);
  return out;
}

route("GET", "/users/@me/friend-suggestions", ({ viewer, query }) => {
  const limit = query.get("limit") === null ? 25 : Number(query.get("limit"));
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid("limit", "Must be between 1 and 100.");
  const me = viewer.user.id;
  if (optedOut.has(me)) return { enabled: false, suggestions: [] };
  const myFriends = friendsOf(me);
  const guildsWith = new Map<string, { id: string; nick: string | null }[]>();
  for (const guild of db.guilds.values()) {
    if (!guild.members.has(me) || guild.members.size > SMALL_GUILD_MEMBERS) continue;
    for (const [id, member] of guild.members) if (id !== me) guildsWith.set(id, [...(guildsWith.get(id) ?? []), { id: guild.guild.id, nick: member.nick }]);
  }
  const mutual = new Map<string, number>();
  for (const friend of myFriends) for (const other of friendsOf(friend)) if (other !== me) mutual.set(other, (mutual.get(other) ?? 0) + 1);
  const candidates = new Set([...guildsWith.keys(), ...mutual.keys()]);
  const ranked: FriendSuggestion[] = [];
  for (const id of candidates) {
    const account = db.accounts.get(id);
    if (!account || account.user.bot || optedOut.has(id) || dismissed.get(me)?.has(id) || relationBetween(me, id)) continue;
    // The count the profile shows: none without a shared guild or a DM with a message (mutualFriendsOf).
    ranked.push({ user: account.user, mutual_guilds: guildsWith.get(id) ?? [], mutual_friends_count: mutualFriendsOf(viewer, account).length });
  }
  ranked.sort((a, b) => b.mutual_friends_count - a.mutual_friends_count || b.mutual_guilds.length - a.mutual_guilds.length || compareIds(a.user.id, b.user.id));
  return { enabled: true, suggestions: ranked.slice(0, limit) };
});

route("DELETE", `/users/@me/friend-suggestions/${ID}`, ({ viewer, params }) => {
  // Answers the same for ids that belong to nobody, so it cannot be used to probe which accounts exist.
  const other = params[0] ?? "";
  if (db.accounts.has(other)) dismissed.set(viewer.user.id, (dismissed.get(viewer.user.id) ?? new Set()).add(other));
  return undefined;
});

route("PATCH", "/users/@me/friend-suggestion-settings", ({ viewer, body }) => {
  if (typeof body.enabled !== "boolean") invalid("enabled", "Must be true or false.");
  if (body.enabled) optedOut.delete(viewer.user.id);
  else optedOut.add(viewer.user.id);
  return { enabled: body.enabled };
});

// ---- dev hook for e2e / the console ----

export interface SeededGuild {
  guildId: string;
  inviteCode: string;
  gamerRoleId: string;
  channels: Record<string, string>;
  /** A member nobody else knows: shows up in friend suggestions once the viewer has joined. */
  strangerId: string;
}

/** A guild owned by `owner` (default alice) with onboarding switched on and an invite code; returns what a test needs. */
export function seedOnboardingGuild(ownerName = "alice"): SeededGuild {
  const owner = [...db.accounts.values()].find(a => a.user.username === ownerName);
  if (!owner) throw new Error(`unknown mock user ${ownerName}`);
  const guildId = createDemoGuild(owner.user.id);
  const guild = db.guilds.get(guildId)!;
  const byName = (name: string) => [...db.channels.values()].find(c => c.guild_id === guildId && c.name === name)!;
  return finishDemoGuild(guild, guildId, byName);
}

function createDemoGuild(ownerId: string): string {
  const id = createGuildRecord(ownerId, "Pixel Pals");
  const category = [...db.channels.values()].find(c => c.guild_id === id && c.type === ChannelType.GuildCategory && c.name === "Text Channels")!;
  addChannel(id, { name: "gaming", type: ChannelType.GuildText, parent_id: category.id });
  addChannel(id, { name: "art", type: ChannelType.GuildText, parent_id: category.id });
  return id;
}

function finishDemoGuild(guild: MockGuild, guildId: string, byName: (name: string) => { id: string }): SeededGuild {
  const stranger = [...db.accounts.values()].find(a => a.user.username === "pixel") ?? createAccount({ username: "pixel", global_name: "Pixel", status: "online" });
  guild.members.set(stranger.user.id, { nick: null, roles: [], joined_at: new Date().toISOString() });
  const roles = [
    { id: nextId(), name: "gamer", color: 0x3ba55d, hoist: false, position: 1, permissions: "0", mentionable: false },
    { id: nextId(), name: "artist", color: 0xc45bd0, hoist: false, position: 2, permissions: "0", mentionable: false },
  ];
  guild.guild.roles.push(...roles);
  const [gamer, artist] = roles as [(typeof roles)[number], (typeof roles)[number]];
  onboardings.set(guildId, {
    enabled: true,
    mode: OnboardingMode.Advanced,
    default_channel_ids: [byName("general").id],
    rules: { description: "A few ground rules before you join in.", items: ["Be kind to everyone.", "No spam or self-promotion.", "Keep it friendly and on topic."] },
    rules_since: Date.now(),
    prompts: [
      {
        id: nextId(),
        type: OnboardingPromptType.MultipleChoice,
        title: "What are you here for?",
        single_select: false,
        required: true,
        in_onboarding: true,
        options: [
          { id: nextId(), title: "Games", description: "Talk games and find people to play with", emoji: { id: null, name: "🎮" }, channel_ids: [byName("gaming").id], role_ids: [gamer.id] },
          { id: nextId(), title: "Art", description: "Share drawings and get feedback", emoji: { id: null, name: "🎨" }, channel_ids: [byName("art").id], role_ids: [artist.id] },
        ],
      },
    ],
  });
  const code = `join${guildId.slice(-6)}`;
  const channel = byName("general") as { id: string };
  db.invites.set(code, { code, guild_id: guildId, channel_id: channel.id, expires_at: null });
  return { guildId, inviteCode: code, gamerRoleId: gamer.id, channels: { general: channel.id, gaming: byName("gaming").id, art: byName("art").id }, strangerId: stranger.user.id };
}

