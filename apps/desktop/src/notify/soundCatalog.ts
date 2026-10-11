// The voice & video sounds the user can switch off one by one (User Settings > Voice & Video > Sounds). Pure data and
// helpers; the synthesised notes live in sounds.ts and the call sites are in voice/engine.ts.

export type VoiceSoundId =
  | "mute"
  | "unmute"
  | "deafen"
  | "undeafen"
  | "camera-on"
  | "camera-off"
  | "voice-connected"
  | "voice-disconnected"
  | "user-join"
  | "user-leave"
  | "user-moved"
  | "stream-start"
  | "stream-stop"
  | "ptt-activate"
  | "ptt-deactivate"
  | "server-mute"
  | "server-deaf"
  | "connection-lost"
  | "connection-restored";

export interface VoiceSoundInfo {
  id: VoiceSoundId;
  label: string;
  /** "primary" rows are always listed, "more" ones sit behind "Show N more". */
  group: "primary" | "more";
}

export const VOICE_SOUNDS: readonly VoiceSoundInfo[] = [
  { id: "mute", label: "Mute", group: "primary" },
  { id: "unmute", label: "Unmute", group: "primary" },
  { id: "deafen", label: "Deafen", group: "primary" },
  { id: "undeafen", label: "Undeafen", group: "primary" },
  { id: "camera-on", label: "Camera On", group: "more" },
  { id: "camera-off", label: "Camera Off", group: "more" },
  { id: "voice-connected", label: "Voice Connected", group: "more" },
  { id: "voice-disconnected", label: "Voice Disconnected", group: "more" },
  { id: "user-join", label: "User Joined", group: "more" },
  { id: "user-leave", label: "User Left", group: "more" },
  { id: "user-moved", label: "User Moved", group: "more" },
  { id: "stream-start", label: "Stream Started", group: "more" },
  { id: "stream-stop", label: "Stream Ended", group: "more" },
  { id: "ptt-activate", label: "Push to Talk Activated", group: "more" },
  { id: "ptt-deactivate", label: "Push to Talk Deactivated", group: "more" },
  { id: "server-mute", label: "Server Muted", group: "more" },
  { id: "server-deaf", label: "Server Deafened", group: "more" },
  { id: "connection-lost", label: "Connection Lost", group: "more" },
  { id: "connection-restored", label: "Connection Restored", group: "more" },
];

const IDS = new Set<string>(VOICE_SOUNDS.map(s => s.id));

export const isVoiceSoundId = (value: string): value is VoiceSoundId => IDS.has(value);

/** Message sounds (User Settings > Notifications > Sounds). They share the `disabledSounds` pref with the voice sounds. */
export type NotifySoundId = "message" | "mention";
export type SoundId = NotifySoundId | VoiceSoundId;

/** Every switchable sound in `disabledSounds` order. */
const ORDER: readonly SoundId[] = ["message", "mention", ...VOICE_SOUNDS.map(s => s.id)];
const ALL_IDS = new Set<string>(ORDER);

export const isSoundId = (value: string): value is SoundId => ALL_IDS.has(value);

/** `disabledSounds` pref (comma separated ids) as a set; unknown ids from older or newer builds are dropped. */
export function parseDisabledSounds(value: string): Set<SoundId> {
  return new Set(value.split(",").map(s => s.trim()).filter(isSoundId));
}

export function serializeDisabledSounds(disabled: Iterable<SoundId>): string {
  const set = new Set(disabled);
  return ORDER.filter(id => set.has(id)).join(",");
}

export const isSoundEnabled = (value: string, id: SoundId): boolean => !parseDisabledSounds(value).has(id);

export function withSoundEnabled(value: string, id: SoundId, enabled: boolean): string {
  return withSoundsEnabled(value, [id], enabled);
}

export function withSoundsEnabled(value: string, ids: Iterable<SoundId>, enabled: boolean): string {
  const set = parseDisabledSounds(value);
  for (const id of ids) {
    if (enabled) set.delete(id);
    else set.add(id);
  }
  return serializeDisabledSounds(set);
}
