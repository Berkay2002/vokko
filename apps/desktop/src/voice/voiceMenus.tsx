// Menu entries the shell's menus pull in: per-user volume + local mute (user context menu, only for people in your call)
// and the input/output device submenus of the user panel.

import type { Snowflake } from "../api/types";
import { getPrefs, setPref, type MenuItem } from "../ui";
import { setLocalMute, setUserVolume } from "./engine";
import { VOLUME_MAX } from "./reducer";
import { getVoice, useVoice } from "./store";

function UserVolumeSlider({ userId }: { userId: Snowflake }) {
  const volume = useVoice(s => s.volumes[userId] ?? 100);
  const muted = useVoice(s => !!s.localMutes[userId]);
  return (
    <label className={`voice-volume${muted ? " muted" : ""}`}>
      <span className="voice-volume-label">User Volume</span>
      <input
        type="range"
        className="voice-volume-range"
        min={0}
        max={VOLUME_MAX}
        step={1}
        value={volume}
        aria-label="User Volume"
        aria-valuetext={`${volume}%`}
        style={{ ["--fill" as string]: `${(volume / VOLUME_MAX) * 100}%` }}
        onChange={e => setUserVolume(userId, Number(e.currentTarget.value))}
        onKeyDown={e => e.stopPropagation()}
      />
      <span className="voice-volume-value">{volume}%</span>
    </label>
  );
}

/** "User Volume" slider and "Mute" (local) for someone in the same call as us; empty otherwise. */
export function voiceUserMenuItems(userId: Snowflake): MenuItem[] {
  const model = getVoice();
  if (!model.channelId || userId === model.meId || model.states[userId]?.channel_id !== model.channelId) return [];
  const muted = !!model.localMutes[userId];
  return [
    { id: "user-volume", label: "User Volume", render: () => <UserVolumeSlider userId={userId} /> },
    { id: "local-mute", label: "Mute", checked: muted, onSelect: () => setLocalMute(userId, !muted) },
  ];
}

function deviceItems(kind: "input" | "output"): MenuItem[] {
  const key = kind === "input" ? "inputDevice" : "outputDevice";
  const devices = getVoice().devices[kind];
  const list = devices.length > 0 ? devices : [{ deviceId: "default", label: "Default" }];
  const current = getPrefs()[key];
  const selected = list.some(d => d.deviceId === current) ? current : "default";
  return list.map(d => ({ id: `${key}-${d.deviceId}`, label: d.label, checked: d.deviceId === selected, onSelect: () => setPref(key, d.deviceId) }));
}

/** "Input Device" submenu for the microphone menu. */
export function inputDeviceMenu(): MenuItem[] {
  return [{ id: "input-device", label: "Input Device", children: deviceItems("input") }];
}

/** "Output Device" submenu, hidden where the runtime cannot pick an output (no setSinkId, e.g. WebKit). */
export function outputDeviceMenu(): MenuItem[] {
  if (!getVoice().devices.outputSelectable) return [];
  return [{ id: "output-device", label: "Output Device", children: deviceItems("output") }];
}
