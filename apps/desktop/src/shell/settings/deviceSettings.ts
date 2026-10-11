import { useEffect, useState } from "react";

/** Persists a JSON value under `vokko.guild.<id>.<name>` until the backend grows real fields. */
export function useDeviceSetting<T extends object>(guildId: string, name: string, fallback: T): [T, (next: T) => void] {
  const key = `vokko.guild.${guildId}.${name}`;
  const read = (): T => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
    } catch {
      return fallback;
    }
  };
  const [value, setValue] = useState<T>(read);
  useEffect(() => setValue(read()), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (next: T) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* storage unavailable: keep in memory only */
    }
  };
  return [value, set];
}

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export const DEVICE_NOTE = "Saved on this device until server support lands.";
