// DM call state (docs/api.md "DM calls"): which DMs have a call, who is being rung, and what the user dismissed locally.
// The pure reducer is what the tests drive; the zustand store wraps it and src/calls/engine.ts feeds it from the gateway.
// Who is *in* a call lives in the voice store (src/voice), keyed by the same channel id.

import { create } from "zustand";
import type { Call, Snowflake } from "../api/types";

export interface CallInfo {
  channelId: Snowflake;
  messageId: Snowflake;
  region: string | null;
  /** Users being rung right now (sorted by id, as the server sends them). */
  ringing: Snowflake[];
}

export interface CallModel {
  meId: Snowflake | null;
  /** channel id → ongoing call */
  calls: Record<Snowflake, CallInfo>;
  /** Incoming rings the user closed without declining on the server (the overlay's close button), by call message id. */
  dismissed: Record<Snowflake, true>;
}

export const initialCallModel: CallModel = { meId: null, calls: {}, dismissed: {} };

export type CallAction =
  | { type: "ready"; meId: Snowflake }
  | { type: "create"; call: Omit<Call, "voice_states"> }
  | { type: "update"; call: Omit<Call, "voice_states"> }
  | { type: "delete"; channelId: Snowflake }
  | { type: "dismiss"; channelId: Snowflake };

function info(call: Omit<Call, "voice_states">): CallInfo {
  return { channelId: call.channel_id, messageId: call.message_id, region: call.region, ringing: [...call.ringing] };
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export function callReducer(model: CallModel, action: CallAction): CallModel {
  switch (action.type) {
    case "ready":
      // A fresh READY: the server re-sends CALL_CREATE for every ongoing call right after it.
      return { meId: action.meId, calls: {}, dismissed: model.meId === action.meId ? model.dismissed : {} };
    case "create":
    case "update": {
      const next = info(action.call);
      const prev = model.calls[next.channelId];
      // A CALL_UPDATE for a call we never saw created (missed while reconnecting) still describes an ongoing call.
      let dismissed = model.dismissed;
      // Rung again after a dismiss (someone pressed "Ring" or a new call started): show it again.
      if (model.meId && next.ringing.includes(model.meId) && (!prev || !prev.ringing.includes(model.meId) || prev.messageId !== next.messageId)) {
        dismissed = without(dismissed, next.messageId);
      }
      return { ...model, calls: { ...model.calls, [next.channelId]: next }, dismissed };
    }
    case "delete": {
      const prev = model.calls[action.channelId];
      if (!prev) return model;
      return { ...model, calls: without(model.calls, action.channelId), dismissed: without(model.dismissed, prev.messageId) };
    }
    case "dismiss": {
      const call = model.calls[action.channelId];
      if (!call) return model;
      return { ...model, dismissed: { ...model.dismissed, [call.messageId]: true } };
    }
    default:
      return model;
  }
}

// ---- selectors ----

/** Calls ringing us that we are not in (`inVoiceChannelId` = the voice store's channelId) and did not dismiss. */
export function incomingCalls(model: CallModel, inVoiceChannelId: Snowflake | null): CallInfo[] {
  const me = model.meId;
  if (!me) return [];
  return Object.values(model.calls).filter(call => call.ringing.includes(me) && call.channelId !== inVoiceChannelId && !model.dismissed[call.messageId]);
}

/** Who we are ringing from inside a call (everyone rung but us). */
export function outgoingRinging(model: CallModel, channelId: Snowflake): Snowflake[] {
  const call = model.calls[channelId];
  if (!call) return [];
  return call.ringing.filter(id => id !== model.meId);
}

/** How long a call lasted, worded like the call row ("a few seconds", "5 minutes", "an hour"). */
export function callDuration(startedIso: string, endedIso: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(endedIso) - Date.parse(startedIso)) / 1000));
  if (seconds < 60) return "a few seconds";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "a minute" : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "an hour" : `${hours} hours`;
}

export interface CallStore extends CallModel {
  dispatch(action: CallAction): void;
}

export const callStore = create<CallStore>()((set, get) => ({
  ...initialCallModel,
  dispatch(action) {
    const model: CallModel = get();
    const next = callReducer(model, action);
    if (next !== model) set(next);
  },
}));

export const useCalls = callStore;
