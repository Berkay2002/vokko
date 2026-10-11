// Read-only view of the gateway's reconnect state for the banners and the splash. Does not touch the reconnect logic.
import { useEffect, useState, useSyncExternalStore } from "react";
import { gateway, type GatewayStatus } from "./gateway";

export interface ConnectionState {
  status: GatewayStatus;
  /** Failed attempts since the last good connection (0 while first connecting or connected). */
  attempt: number;
  /** Epoch ms when the next socket opens; null while an attempt is in flight or when connected. */
  nextRetryAt: number | null;
}

const read = (): ConnectionState => ({ status: gateway.status, attempt: gateway.retry.attempt, nextRetryAt: gateway.retry.nextRetryAt });
let snapshot = read();

function getSnapshot(): ConnectionState {
  const next = read();
  if (next.status !== snapshot.status || next.attempt !== snapshot.attempt || next.nextRetryAt !== snapshot.nextRetryAt) snapshot = next;
  return snapshot;
}

function subscribe(onChange: () => void): () => void {
  const stopStatus = gateway.onStatus(onChange);
  const stopRetry = gateway.onRetry(onChange);
  return () => {
    stopStatus();
    stopRetry();
  };
}

export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Whole seconds until `at` (epoch ms), ticking while it is in the future; null when `at` is null. */
export function useCountdown(at: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [at]);
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000));
}
