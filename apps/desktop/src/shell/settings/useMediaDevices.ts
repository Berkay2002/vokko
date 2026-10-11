import { useCallback, useEffect, useState } from "react";

export interface DeviceOption {
  value: string;
  label: string;
}

export interface MediaDeviceLists {
  inputs: DeviceOption[];
  outputs: DeviceOption[];
  cameras: DeviceOption[];
  /** The browser can list devices at all. */
  apiOk: boolean;
  /** Names are blank until the user has granted a device permission once. */
  noLabels: boolean;
  refresh(): Promise<void>;
}

const DEFAULT_DEVICE: DeviceOption = { value: "default", label: "Default" };

const hasMediaApi = (): boolean => typeof navigator !== "undefined" && !!navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === "function";

function toOptions(devices: MediaDeviceInfo[], kind: MediaDeviceKind): { options: DeviceOption[]; unnamed: boolean } {
  const matching = devices.filter(d => d.kind === kind && d.deviceId !== "default" && d.deviceId !== "");
  return {
    options: [DEFAULT_DEVICE, ...matching.map((d, i) => ({ value: d.deviceId, label: d.label || `Device ${i + 1}` }))],
    unnamed: matching.length > 0 && matching.every(d => !d.label),
  };
}

/** Lists audio in/out and camera devices (default entry first) and follows plug / unplug. Never opens a device itself. */
export function useMediaDevices(): MediaDeviceLists {
  const [apiOk] = useState(hasMediaApi);
  const [state, setState] = useState({ inputs: [DEFAULT_DEVICE], outputs: [DEFAULT_DEVICE], cameras: [DEFAULT_DEVICE], noLabels: false });

  const refresh = useCallback(async () => {
    if (!hasMediaApi()) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = toOptions(devices, "audioinput");
      const outputs = toOptions(devices, "audiooutput");
      const cameras = toOptions(devices, "videoinput");
      setState({ inputs: inputs.options, outputs: outputs.options, cameras: cameras.options, noLabels: inputs.unnamed || cameras.unnamed });
    } catch {
      // keep the default-only lists
    }
  }, []);

  useEffect(() => {
    if (!hasMediaApi()) return;
    void refresh();
    const md = navigator.mediaDevices;
    md.addEventListener("devicechange", refresh);
    return () => md.removeEventListener("devicechange", refresh);
  }, [refresh]);

  return { ...state, apiOk, refresh };
}

/** The stored device when it is still listed, otherwise "default". */
export function listedDevice(list: DeviceOption[], stored: string): string {
  return list.some(d => d.value === stored) ? stored : "default";
}
