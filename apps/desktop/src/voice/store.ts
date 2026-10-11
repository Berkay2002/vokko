// Zustand store around the pure reducer. Per-user volume / local mute, self mute / deafen and the push-to-talk key persist in
// localStorage (`vokko.voice`); device, input mode and sensitivity live in the shared prefs (src/ui/prefs.ts) and are mirrored in by the engine.

import { create } from "zustand";
import type { Snowflake, VoiceState } from "../api/types";
import { channelOccupants, initialVoiceModel, isSpeaking, voiceReducer, type VoiceAction, type VoiceModel } from "./reducer";

const KEY = "vokko.voice";

interface Persisted {
  volumes: Record<Snowflake, number>;
  localMutes: Record<Snowflake, true>;
  pttKey: string | null;
  pttReleaseMs: number;
  selfMute: boolean;
  selfDeaf: boolean;
  muteBeforeDeaf: boolean;
}

function load(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    const out: Partial<Persisted> = {};
    if (parsed.volumes && typeof parsed.volumes === "object") {
      out.volumes = Object.fromEntries(Object.entries(parsed.volumes).filter(([, v]) => typeof v === "number" && v >= 0 && v <= 200));
    }
    if (parsed.localMutes && typeof parsed.localMutes === "object") out.localMutes = Object.fromEntries(Object.keys(parsed.localMutes).map(id => [id, true as const]));
    if (typeof parsed.pttKey === "string" || parsed.pttKey === null) out.pttKey = parsed.pttKey;
    if (typeof parsed.pttReleaseMs === "number") out.pttReleaseMs = Math.max(0, Math.min(2000, parsed.pttReleaseMs));
    if (typeof parsed.selfDeaf === "boolean") out.selfDeaf = parsed.selfDeaf;
    // Deafened implies muted (the reducer keeps that invariant; a hand-edited file must not break it).
    if (typeof parsed.selfMute === "boolean") out.selfMute = parsed.selfMute || !!out.selfDeaf;
    if (typeof parsed.muteBeforeDeaf === "boolean") out.muteBeforeDeaf = parsed.muteBeforeDeaf;
    return out;
  } catch {
    return {};
  }
}

const persistedChanged = (a: VoiceModel, b: VoiceModel): boolean =>
  a.volumes !== b.volumes ||
  a.localMutes !== b.localMutes ||
  a.settings.pttKey !== b.settings.pttKey ||
  a.settings.pttReleaseMs !== b.settings.pttReleaseMs ||
  a.selfMute !== b.selfMute ||
  a.selfDeaf !== b.selfDeaf ||
  a.muteBeforeDeaf !== b.muteBeforeDeaf;

function save(model: VoiceModel): void {
  const data: Persisted = {
    volumes: model.volumes,
    localMutes: model.localMutes,
    pttKey: model.settings.pttKey,
    pttReleaseMs: model.settings.pttReleaseMs,
    selfMute: model.selfMute,
    selfDeaf: model.selfDeaf,
    muteBeforeDeaf: model.muteBeforeDeaf,
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* storage full or unavailable: the setting still applies for this session */
  }
}

/** Initial model with the persisted parts restored (exported for tests). */
export function initialFromStorage(): VoiceModel {
  const stored = load();
  return {
    ...initialVoiceModel,
    volumes: stored.volumes ?? {},
    localMutes: stored.localMutes ?? {},
    selfMute: stored.selfMute ?? false,
    selfDeaf: stored.selfDeaf ?? false,
    muteBeforeDeaf: stored.muteBeforeDeaf ?? false,
    settings: { ...initialVoiceModel.settings, pttKey: stored.pttKey ?? null, pttReleaseMs: stored.pttReleaseMs ?? initialVoiceModel.settings.pttReleaseMs },
  };
}

export interface VoiceStore extends VoiceModel {
  dispatch(action: VoiceAction): void;
}

export const voiceStore = create<VoiceStore>()((set, get) => ({
  ...initialFromStorage(),
  dispatch(action) {
    const model: VoiceModel = get();
    const next = voiceReducer(model, action);
    if (next === model) return;
    set(next);
    if (persistedChanged(next, model)) save(next);
  },
}));

export const useVoice = voiceStore;
export const getVoice = (): VoiceStore => voiceStore.getState();

const NONE: VoiceState[] = [];
/** Last occupant list per channel, so selectors return a stable array while nothing in the channel changed. */
const occupantCache = new Map<Snowflake, VoiceState[]>();

/** Voice states in a channel, in join order. */
export function useChannelVoiceStates(channelId: Snowflake): VoiceState[] {
  return voiceStore(s => {
    const list = channelOccupants(s, channelId);
    const prev = occupantCache.get(channelId);
    if (prev && prev.length === list.length && prev.every((v, i) => v === list[i])) return prev;
    const next = list.length === 0 ? NONE : list;
    occupantCache.set(channelId, next);
    return next;
  });
}

export const useIsSpeaking = (userId: Snowflake): boolean => voiceStore(s => isSpeaking(s, userId));
