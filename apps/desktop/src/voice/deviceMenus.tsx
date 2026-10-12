// Microphone and headphone menus behind the chevrons: the user panel and the voice page control bar share them.

import { useEffect } from "react";
import { Settings } from "lucide-react";
import { openModal } from "../shell/modalStore";
import { setPref, usePrefs, type MenuItem } from "../ui";
import { refreshVoiceDevices } from "./engine";
import type { InputProfile } from "./audioProfile";
import { inputDeviceMenu, outputDeviceMenu } from "./voiceMenus";
import { getVoice } from "./store";

/** A volume slider row inside a menu, bound to a 0..100 preference. */
function VolumeRow({ label, pref }: { label: string; pref: "inputVolume" | "outputVolume" }) {
  const value = usePrefs()[pref];
  return (
    <label className="voice-volume wide">
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
    </label>
  );
}

/** Name of the selected device ("Default" when the saved id is gone or was never set). */
function currentDevice(kind: "input" | "output", saved: string): string {
  const list = getVoice().devices[kind];
  return list.find(d => d.deviceId === saved)?.label ?? list.find(d => d.deviceId === "default")?.label ?? "Default";
}

const PROFILES: { value: InputProfile; label: string }[] = [
  { value: "isolation", label: "Voice Isolation" },
  { value: "studio", label: "Studio" },
  { value: "custom", label: "Custom" },
];

/** Item builders for the "Input Options" / "Output Options" menus. Re-enumerates devices once when first used. */
export function useDeviceMenus(): { micItems: () => MenuItem[]; headphoneItems: () => MenuItem[] } {
  const prefs = usePrefs();
  useEffect(() => void refreshVoiceDevices(), []);
  const voiceSettings = (): MenuItem => ({ id: "voice-settings", label: "Voice Settings", icon: <Settings size={20} />, iconStart: true, onSelect: () => openModal({ type: "userSettings", section: "voice" }) });
  const withSub = (items: MenuItem[], sub: string): MenuItem[] => items.map(item => ("type" in item ? item : { ...item, sub }));
  const micItems = (): MenuItem[] => [
    ...withSub(inputDeviceMenu(), currentDevice("input", prefs.inputDevice)),
    {
      id: "input-profile",
      label: "Input Profile",
      sub: PROFILES.find(p => p.value === prefs.inputProfile)?.label ?? "Custom",
      children: PROFILES.map(p => ({ id: `profile-${p.value}`, label: p.label, checked: prefs.inputProfile === p.value, onSelect: () => setPref("inputProfile", p.value) })),
    },
    { type: "separator" },
    { id: "input-volume", label: "Input Volume", render: () => <VolumeRow label="Input Volume" pref="inputVolume" /> },
    { type: "separator" },
    voiceSettings(),
  ];
  const headphoneItems = (): MenuItem[] => [
    ...withSub(outputDeviceMenu(), currentDevice("output", prefs.outputDevice)),
    { type: "separator" },
    { id: "output-volume", label: "Output Volume", render: () => <VolumeRow label="Output Volume" pref="outputVolume" /> },
    { type: "separator" },
    voiceSettings(),
  ];
  return { micItems, headphoneItems };
}
