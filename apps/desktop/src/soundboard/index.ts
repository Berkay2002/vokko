// Soundboard and entrance sounds. main.tsx imports this module once for its side effects (styles,
// gateway wiring); the voice UI and the settings pages import the pieces they mount from here.
import "./soundboard.css";
import { wireSoundboard } from "./store";

if (typeof window !== "undefined") wireSoundboard();

export { SoundboardPanel } from "./SoundboardPanel";
export { SoundboardSettingsPage } from "./SoundboardSettingsPage";
export { EntranceSoundField, SoundboardVoiceSettings } from "./EntranceSound";
export { SoundEffectBadge, useSoundFlashClass } from "./SoundEffectBadge";
