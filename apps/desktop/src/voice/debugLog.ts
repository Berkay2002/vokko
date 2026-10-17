// Voice & Video > Advanced > Debug logging: connection events and WebRTC statistics go to the developer console.
// Off by default; the pref is read on every call so the switch takes effect without reconnecting.
// Events always go to the "Report a problem" log ring, which is only sent when the user reports.

import { recordLog } from "../report/logBuffer";
import { getPrefs } from "../ui/prefs";

export function voiceDebugEnabled(): boolean {
  return getPrefs().debugLogging;
}

export function voiceDebug(event: string, detail?: unknown): void {
  recordLog("voice", detail === undefined ? [event] : [event, detail]);
  if (!voiceDebugEnabled()) return;
  if (detail === undefined) console.debug(`[vokko:voice] ${event}`);
  else console.debug(`[vokko:voice] ${event}`, detail);
}

/** The few outbound/inbound RTP fields that explain a quality complaint, from a track's RTCStatsReport. */
export function summariseRtpStats(report: RTCStatsReport): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  report.forEach(stat => {
    if (stat.type !== "outbound-rtp" && stat.type !== "inbound-rtp") return;
    const s = stat as Record<string, unknown>;
    out.push({
      type: s.type,
      kind: s.kind,
      codec: s.codecId,
      width: s.frameWidth,
      height: s.frameHeight,
      fps: s.framesPerSecond,
      bytes: s.type === "outbound-rtp" ? s.bytesSent : s.bytesReceived,
      limited: s.qualityLimitationReason,
      lost: s.packetsLost,
    });
  });
  return out;
}
