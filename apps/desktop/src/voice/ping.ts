// Ping measurement helpers: the displayed ping is a rolling average of recent samples (like Discord's), not the raw latest
// value, and prefers the round-trip time of the selected ICE candidate pair (the real media path) over the signalling
// WebSocket RTT. Pure functions, unit-tested without livekit-client.

/** Polls averaged for the shown ping (the poll is 2 s, so about the last 12 s). */
export const PING_WINDOW = 6;

/** Rolling mean of the last `size` samples. Reset it when the connection path changes (reconnect). */
export class PingSmoother {
  private samples: number[] = [];

  constructor(private readonly size: number = PING_WINDOW) {}

  /** Adds a raw sample (ms) and returns the rolling average, rounded. */
  push(ms: number): number {
    this.samples.push(ms);
    if (this.samples.length > this.size) this.samples.shift();
    return Math.round(this.samples.reduce((sum, s) => sum + s, 0) / this.samples.length);
  }

  reset(): void {
    this.samples = [];
  }
}

/** Round-trip time in ms of the selected candidate pair in a peer connection's stats, or null when there is none yet. */
export function selectedPairRttMs(report: RTCStatsReport): number | null {
  let selectedId: string | undefined;
  const pairs: Record<string, unknown>[] = [];
  report.forEach(stat => {
    const s = stat as Record<string, unknown>;
    if (s.type === "transport" && typeof s.selectedCandidatePairId === "string" && s.selectedCandidatePairId) selectedId = s.selectedCandidatePairId;
    else if (s.type === "candidate-pair") pairs.push(s);
  });
  // `transport.selectedCandidatePairId` is the standard link; `selected` / nominated+succeeded cover browsers without it.
  const pair = pairs.find(p => p.id === selectedId) ?? pairs.find(p => p.selected === true) ?? pairs.find(p => p.nominated === true && p.state === "succeeded");
  const seconds = pair?.currentRoundTripTime;
  return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : null;
}
