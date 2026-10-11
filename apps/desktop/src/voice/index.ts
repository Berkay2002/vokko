// Voice channels V1 (docs/design/voice.md §3): store, engine, transports and the UI pieces the shell mounts.
// Importing this module (main.tsx) wires the engine to the gateway.

import "./voice.css";
import { wireVoice } from "./engine";

export {
  dismissVoiceError,
  isChannelFull,
  joinRefusal,
  joinVoiceChannel,
  leaveVoice,
  refreshVoiceDevices,
  setLocalMute,
  setPttKey,
  setPttReleaseMs,
  setSelfDeaf,
  setSelfMute,
  setUserVolume,
  setVoiceChannelStatus,
  toggleSelfDeaf,
  toggleSelfMute,
} from "./engine";
export { getVoice, useChannelVoiceStates, useIsSpeaking, useVoice, voiceStore } from "./store";
export type { ConnectionQuality, InputMode, VoiceError, VoiceErrorReason, VoiceModel, VoiceSettings, VoiceStatus } from "./reducer";
export { VoiceChannelBadge, VoiceChannelUsers } from "./VoiceChannelUsers";
export { VoiceConnectionPanel } from "./VoiceConnectionPanel";
export { PttSettings } from "./PttSettings";
export { inputDeviceMenu, outputDeviceMenu, voiceUserMenuItems } from "./voiceMenus";

if (typeof window !== "undefined") wireVoice();
