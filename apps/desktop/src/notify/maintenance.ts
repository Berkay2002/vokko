// Maintenance notice from the optional `GET /api/v1/status` (a proposal, see docs/api.md "Proposed"). Only the mock implements it for now:
// a real server is polled only when the build sets VITE_VOKKO_STATUS=1, so nobody pays a 404 per minute for it.
import { create } from "zustand";
import { MOCK } from "../api/config";
import { gateway } from "../api/gateway";
import { request } from "../api/rest";

export interface MaintenanceNotice {
  message: string;
  /** ISO time the maintenance starts (a future time reads as "scheduled"); null when it is already happening. */
  startsAt: string | null;
}

interface StatusResponse {
  maintenance?: { message?: unknown; starts_at?: unknown } | null;
}

const POLL_MS = 60_000;
export const STATUS_ENABLED = MOCK || import.meta.env.VITE_VOKKO_STATUS === "1";
/** The mock's fault hook fires this so a test does not wait out the poll interval. */
export const STATUS_CHANGED_EVENT = "vokko:status-changed";

export const useMaintenance = create<{ notice: MaintenanceNotice | null }>(() => ({ notice: null }));

function parse(response: StatusResponse | undefined): MaintenanceNotice | null {
  const m = response?.maintenance;
  if (!m || typeof m.message !== "string" || m.message.trim() === "") return null;
  return { message: m.message.trim(), startsAt: typeof m.starts_at === "string" ? m.starts_at : null };
}

export async function refreshMaintenance(): Promise<void> {
  try {
    const notice = parse(await request<StatusResponse>("GET", "/status"));
    const current = useMaintenance.getState().notice;
    if (current?.message !== notice?.message || current?.startsAt !== notice?.startsAt) useMaintenance.setState({ notice });
  } catch {
    /* optional endpoint: a failure keeps whatever was last known */
  }
}

let stop: (() => void) | null = null;

/** Starts polling while signed in; call the returned function (or `stopMaintenanceWatch`) when the session ends. */
export function startMaintenanceWatch(): () => void {
  if (!STATUS_ENABLED || stop) return stop ?? (() => undefined);
  void refreshMaintenance();
  const timer = setInterval(() => void refreshMaintenance(), POLL_MS);
  const onChanged = () => void refreshMaintenance();
  window.addEventListener(STATUS_CHANGED_EVENT, onChanged);
  const offReady = gateway.on("READY", onChanged);
  stop = () => {
    clearInterval(timer);
    window.removeEventListener(STATUS_CHANGED_EVENT, onChanged);
    offReady();
    stop = null;
    useMaintenance.setState({ notice: null });
  };
  return stop;
}
