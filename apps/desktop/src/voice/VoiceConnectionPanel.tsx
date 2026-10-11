import { useEffect } from "react";
import { PhoneOff, Signal, SignalLow, SignalMedium, X } from "lucide-react";
import { useStore } from "../api/store";
import { Tooltip } from "../ui";
import { dismissVoiceError, leaveVoice } from "./engine";
import type { ConnectionQuality, VoiceErrorReason, VoiceStatus } from "./reducer";
import { useVoice } from "./store";

const STATUS_LABEL: Record<VoiceStatus, string> = {
  idle: "Voice Disconnected",
  connecting: "Connecting",
  rtc_connecting: "RTC Connecting",
  connected: "Voice Connected",
  reconnecting: "Reconnecting",
  disconnected: "Voice Disconnected",
};

export const VOICE_ERROR_TEXT: Record<VoiceErrorReason, string> = {
  missing_permissions: "You don't have permission to join this channel.",
  channel_full: "This channel is full.",
  video_full: "Too many cameras are on in this channel.",
  blocked: "You can't join this call.",
  timed_out: "You can't join voice while timed out.",
  media_unavailable: "Voice is not available on this server.",
  moved: "Voice moved to another device.",
  kicked: "You were disconnected from voice.",
  connection_lost: "Lost the voice connection and could not reconnect.",
  permission_denied: "Microphone access was denied. Others can't hear you.",
  no_microphone: "No microphone found. Others can't hear you.",
};

const QUALITY_LABEL: Record<ConnectionQuality, string> = { excellent: "Excellent", good: "Good", poor: "Poor", lost: "Lost", unknown: "Unknown" };
/** Errors clear themselves after this long when we are not in a call. */
const ERROR_TTL_MS = 8000;

function QualityIcon({ quality }: { quality: ConnectionQuality }) {
  if (quality === "poor" || quality === "lost") return <SignalLow size={18} aria-hidden="true" />;
  if (quality === "good") return <SignalMedium size={18} aria-hidden="true" />;
  return <Signal size={18} aria-hidden="true" />;
}

/** Discord-style RTC panel above the user panel: status, where you are, ping, disconnect. */
export function VoiceConnectionPanel() {
  const channelId = useVoice(s => s.channelId);
  const guildId = useVoice(s => s.guildId);
  const status = useVoice(s => s.status);
  const error = useVoice(s => s.error);
  const quality = useVoice(s => s.quality);
  const ping = useVoice(s => s.pingMs);
  const channel = useStore(s => (channelId ? s.channels[channelId] : undefined));
  const guild = useStore(s => (guildId ? s.guilds[guildId] : undefined));

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(dismissVoiceError, ERROR_TTL_MS);
    return () => clearTimeout(timer);
  }, [error]);

  if (!channelId && !error) return null;
  const inCall = channelId !== null;
  const label = inCall ? STATUS_LABEL[status] : STATUS_LABEL.disconnected;
  const tone = !inCall ? "error" : status === "connected" ? `ok q-${quality}` : status === "reconnecting" ? "warn" : "pending";
  const details = inCall ? [`Connection: ${QUALITY_LABEL[quality]}`, ping !== null ? `Ping: ${ping} ms` : null].filter(Boolean).join(" · ") : "";

  return (
    <section className="voice-panel" aria-label="Voice connection">
      <div className="voice-panel-info">
        <Tooltip content={details || label} side="top" disabled={!inCall}>
          <span className={`voice-panel-status ${tone}`} role="status" aria-live="polite">
            <QualityIcon quality={status === "connected" ? quality : "unknown"} />
            <span className="voice-panel-status-text">{label}</span>
          </span>
        </Tooltip>
        {inCall && (
          <span className="voice-panel-where">
            {channel?.name ?? "Voice"}
            {guild ? ` / ${guild.name}` : ""}
          </span>
        )}
        {error && <span className="voice-panel-error">{VOICE_ERROR_TEXT[error.reason]}</span>}
      </div>
      {inCall ? (
        <Tooltip content="Disconnect" side="top">
          <button type="button" className="voice-panel-button danger" aria-label="Disconnect" onClick={leaveVoice}>
            <PhoneOff size={20} />
          </button>
        </Tooltip>
      ) : (
        <button type="button" className="voice-panel-button" aria-label="Dismiss" onClick={dismissVoiceError}>
          <X size={18} />
        </button>
      )}
    </section>
  );
}
