// Microphone and headphone menus behind the chevrons: the user panel and the voice page control bar share them.

import { useEffect } from "react";
import { openModal } from "../shell/modalStore";
import { setPref, usePrefs, type MenuItem } from "../ui";
import { refreshVoiceDevices } from "./engine";
import { inputDeviceMenu, outputDeviceMenu } from "./voiceMenus";
import { getVoice } from "./store";

/** A volume slider row inside a menu, bound to a 0..100 preference. */
function VolumeRow({ label, pref }: { label: string; pref: "inputVolume" | "outputVolume" }) {
  const value = usePrefs()[pref];
  return (
    <label className="voice-volume">
      <span className="voice-volume-label">{label}</span>
      <input
        type="range"
        className="voice-volume-range"
        min={0}
        max={100}
        step={1}
        value={value}
        aria-label={label}
        aria-valuetext={`${value}%`}
        style={{ ["--fill" as string]: `${value}%` }}
        onChange={e => setPref(pref, Number(e.currentTarget.value))}
        onKeyDown={e => e.stopPropagation()}
      />
      <span className="voice-volume-value">{value}%</span>
    </label>
  );
}

/** Name of the selected device ("Default" when the saved id is gone or was never set). */
function currentDevice(kind: "input" | "output", saved: string): string {
  const list = getVoice().devices[kind];
  return list.find(d => d.deviceId === saved)?.label ?? list.find(d => d.deviceId === "default")?.label ?? "Default";
}

/** Item builders for the "Input Options" / "Output Options" menus. Re-enumerates devices once when first used. */
export function useDeviceMenus(): { micItems: () => MenuItem[]; headphoneItems: () => MenuItem[] } {
  const prefs = usePrefs();
  useEffect(() => void refreshVoiceDevices(), []);
  const voiceSettings = (): MenuItem => ({ id: "voice-settings", label: "Voice Settings", onSelect: () => openModal({ type: "userSettings", section: "voice" }) });
  const withHint = (items: MenuItem[], hint: string): MenuItem[] => items.map(item => ("type" in item ? item : { ...item, hint }));
  const micItems = (): MenuItem[] => [
    ...withHint(inputDeviceMenu(), currentDevice("input", prefs.inputDevice)),
    {
      id: "input-mode",
      label: "Input Mode",
      hint: prefs.inputMode === "ptt" ? "Push to Talk" : "Voice Activity",
      children: [
        { id: "mode-vad", label: "Voice Activity", checked: prefs.inputMode === "vad", onSelect: () => setPref("inputMode", "vad") },
        { id: "mode-ptt", label: "Push to Talk", checked: prefs.inputMode === "ptt", onSelect: () => setPref("inputMode", "ptt") },
      ],
    },
    { type: "separator" },
    { id: "input-volume", label: "Input Volume", render: () => <VolumeRow label="Input Volume" pref="inputVolume" /> },
    { type: "separator" },
    voiceSettings(),
  ];
  const headphoneItems = (): MenuItem[] => [
    ...withHint(outputDeviceMenu(), currentDevice("output", prefs.outputDevice)),
    { type: "separator" },
    { id: "output-volume", label: "Output Volume", render: () => <VolumeRow label="Output Volume" pref="outputVolume" /> },
    { type: "separator" },
    voiceSettings(),
  ];
  return { micItems, headphoneItems };
}
