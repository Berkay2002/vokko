// Audio device choice → deviceId. Older prefs stored device LABELS ("Headset Microphone (USB)") where we now store deviceIds,
// and a stored device may be unplugged: both resolve against the enumerated devices and fall back to the default device.

export interface DeviceLike {
  deviceId: string;
  label: string;
}

/** "default" for the system default device; otherwise a deviceId to request. */
export function resolveDeviceId(pref: string | null | undefined, devices: readonly DeviceLike[]): string {
  const wanted = pref?.trim();
  if (!wanted || wanted === "default") return "default";
  const known = devices.filter(d => d.deviceId && d.deviceId !== "default");
  if (known.some(d => d.deviceId === wanted)) return wanted;
  const byLabel = known.find(d => d.label === wanted) ?? known.find(d => d.label.trim().toLowerCase() === wanted.toLowerCase());
  if (byLabel) return byLabel.deviceId;
  // Nothing enumerable (no device permission yet: ids and labels are blank): try the stored value, a failure falls back.
  if (known.length === 0) return wanted;
  return "default";
}

/** getUserMedia / setSinkId errors that mean "this device is gone or cannot satisfy the request": retry with the default. */
export function isDeviceFailure(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "OverconstrainedError" || name === "NotFoundError" || name === "NotReadableError" || name === "DevicesNotFoundError" || name === "ConstraintNotSatisfiedError";
}

/**
 * Runs `attempt` with the resolved device and, if that device fails, once more with the default device.
 * Returns the deviceId that worked.
 */
export async function withDeviceFallback<T>(deviceId: string, attempt: (deviceId: string) => Promise<T>): Promise<{ deviceId: string; result: T }> {
  try {
    return { deviceId, result: await attempt(deviceId) };
  } catch (error) {
    if (deviceId === "default" || !isDeviceFailure(error)) throw error;
    return { deviceId: "default", result: await attempt("default") };
  }
}
