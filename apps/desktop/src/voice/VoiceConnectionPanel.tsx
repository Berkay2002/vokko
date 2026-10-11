import { useEffect, useState, type ReactNode } from "react";
import { AudioLines, Bug, LayoutGrid, Lock, Music, MonitorUp, PhoneOff, Signal, SignalHigh, SignalLow, SignalMedium, Upload, VideoOff, X } from "lucide-react";
import { useStore } from "../api/store";
import { openModal } from "../shell/modalStore";
import { Popout, Tooltip, setPref, usePrefs } from "../ui";
import { dismissVoiceError, leaveVoice } from "./engine";
import type { ConnectionQuality, VoiceErrorReason, VoiceStatus } from "./reducer";
import { SoundboardPopout } from "./SoundboardPopout";
import { useVoice } from "./store";
import { useVoiceUi, type PingSample } from "./uiStore";

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

export const QUALITY_LABEL: Record<ConnectionQuality, string> = { excellent: "Excellent", good: "Good", poor: "Poor", lost: "Lost", unknown: "Unknown" };
/** Errors clear themselves after this long when we are not in a call. */
const ERROR_TTL_MS = 8000;

export function QualityIcon({ quality, size = 20 }: { quality: ConnectionQuality; size?: number }) {
  if (quality === "poor" || quality === "lost") return <SignalLow size={size} aria-hidden="true" />;
  if (quality === "good") return <SignalMedium size={size} aria-hidden="true" />;
  if (quality === "excellent") return <SignalHigh size={size} aria-hidden="true" />;
  return <Signal size={size} aria-hidden="true" />;
}

function PanelButton({ label, tooltip, disabled, pressed, onClick, children }: { label: string; tooltip?: string; disabled?: boolean; pressed?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <Tooltip content={tooltip ?? label} side="top">
      <button type="button" className="voice-panel-tool" aria-label={label} aria-pressed={pressed} aria-disabled={disabled || undefined} onClick={disabled ? undefined : onClick}>
        {children}
      </button>
    </Tooltip>
  );
}

const CHART_W = 268;
const CHART_H = 85;

/** Ping history as a small line chart: time runs left to right, the y axis tops out at the highest ping (at least 5 ms). */
function PingChart({ samples }: { samples: PingSample[] }) {
  const max = Math.max(5, ...samples.map(s => s.ms));
  const first = samples[0]?.at ?? 0;
  const last = samples[samples.length - 1]?.at ?? 0;
  const span = Math.max(60_000, last - first);
  const x = (at: number) => ((at - last + span) / span) * (CHART_W - 28);
  const y = (ms: number) => CHART_H - 14 - (ms / max) * (CHART_H - 24);
  const points = samples.map(s => `${x(s.at).toFixed(1)},${y(s.ms).toFixed(1)}`).join(" ");
  const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <svg className="voice-quality-chart" width={CHART_W} height={CHART_H} viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label="Ping history">
      {samples.length > 1 && <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />}
      {samples.length === 1 && <circle cx={x(samples[0]!.at)} cy={y(samples[0]!.ms)} r="2" fill="currentColor" />}
      <text x={CHART_W - 2} y="10" textAnchor="end" className="voice-quality-axis">
        {max}
      </text>
      <text x={CHART_W - 2} y={CHART_H - 14} textAnchor="end" className="voice-quality-axis">
        0
      </text>
      {samples.length > 0 && (
        <text x="2" y={CHART_H - 2} className="voice-quality-axis">
          {clock(last)}
        </text>
      )}
    </svg>
  );
}

/** Connection details popout: ping history, where the call is hosted, quality and a secure-connection note. */
function ConnectionPopout({ anchor, open, onClose }: { anchor: HTMLElement | null; open: boolean; onClose: () => void }) {
  const quality = useVoice(s => s.quality);
  const ping = useVoice(s => s.pingMs);
  const status = useVoice(s => s.status);
  const endpoint = useVoice(s => s.server?.endpoint);
  const history = useVoiceUi(s => s.pingHistory);
  let host = "";
  try {
    host = endpoint ? new URL(endpoint.replace(/^wss?:/, "https:").replace(/^mock:/, "https:")).host : "";
  } catch {
    host = "";
  }
  const average = history.length > 0 ? Math.round(history.reduce((sum, s) => sum + s.ms, 0) / history.length) : null;
  const secure = !endpoint || /^(wss|https|mock):/.test(endpoint);
  return (
    <Popout anchor={anchor} open={open} onClose={onClose} side="top" align="start" gap={8} className="voice-quality-popout">
      <PingChart samples={history} />
      <h3 className="voice-quality-title">{host || STATUS_LABEL[status]}</h3>
      <p className="voice-quality-ping">
        Average ping: <b>{average !== null ? `${average} ms` : "–"}</b>
      </p>
      <p className="voice-quality-ping">
        Last ping: <b>{ping !== null ? `${ping} ms` : "–"}</b>
      </p>
      <p className={`voice-quality-ping q-${quality}`}>
        Connection: <QualityIcon quality={quality} size={12} /> <b>{QUALITY_LABEL[quality]}</b>
      </p>
      <p className="voice-quality-help">You may notice audio delay at 250 ms or higher. If the problem persists, you can disconnect and try again.</p>
      <div className="voice-quality-actions">
        <Tooltip content="Not available yet" side="top">
          <button type="button" className="voice-quality-button" aria-disabled="true">
            <Bug size={16} aria-hidden="true" /> Troubleshoot
          </button>
        </Tooltip>
        <Tooltip content="Not available yet" side="top">
          <button type="button" className="voice-quality-button" aria-disabled="true">
            <Upload size={16} aria-hidden="true" /> Upload Logs
          </button>
        </Tooltip>
      </div>
      {secure && (
        <div className="voice-quality-secure">
          <Lock size={12} aria-hidden="true" /> Secure connection
        </div>
      )}
    </Popout>
  );
}

/** Voice section of the user card: status, where you are, noise suppression, disconnect and the four call tools. */
export function VoiceConnectionPanel() {
  const channelId = useVoice(s => s.channelId);
  const guildId = useVoice(s => s.guildId);
  const status = useVoice(s => s.status);
  const error = useVoice(s => s.error);
  const quality = useVoice(s => s.quality);
  const ping = useVoice(s => s.pingMs);
  const deafened = useVoice(s => s.selfDeaf);
  const channel = useStore(s => (channelId ? s.channels[channelId] : undefined));
  const guild = useStore(s => (guildId ? s.guilds[guildId] : undefined));
  const noiseSuppression = usePrefs().noiseSuppression;
  const [qualityAnchor, setQualityAnchor] = useState<HTMLElement | null>(null);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [boardAnchor, setBoardAnchor] = useState<HTMLElement | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);

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
    <section className={`voice-panel${inCall ? " in-call" : ""}`} aria-label="Voice connection">
      <div className="voice-panel-head">
        <Tooltip content={details || label} side="top" disabled={!inCall}>
          <button ref={setQualityAnchor} type="button" className={`voice-panel-signal ${tone}`} aria-label="Connection details" aria-haspopup="dialog" aria-expanded={qualityOpen} disabled={!inCall} onClick={() => setQualityOpen(o => !o)}>
            <QualityIcon quality={status === "connected" ? quality : "unknown"} />
          </button>
        </Tooltip>
        <div className="voice-panel-info">
          <span className={`voice-panel-status ${tone}`} role="status" aria-live="polite">
            {label}
          </span>
          {inCall && (
            <span className="voice-panel-where">
              {channel?.name ?? "Voice"}
              {guild ? ` / ${guild.name}` : ""}
            </span>
          )}
          {error && <span className="voice-panel-error">{VOICE_ERROR_TEXT[error.reason]}</span>}
        </div>
        {inCall ? (
          <>
            <PanelButton label="Noise Suppression" tooltip={noiseSuppression ? "Noise Suppression: on" : "Noise Suppression: off"} pressed={noiseSuppression} onClick={() => setPref("noiseSuppression", !noiseSuppression)}>
              <AudioLines size={20} />
            </PanelButton>
            <Tooltip content="Disconnect" side="top">
              <button type="button" className="voice-panel-tool danger" aria-label="Disconnect" onClick={leaveVoice}>
                <PhoneOff size={20} />
              </button>
            </Tooltip>
          </>
        ) : (
          <button type="button" className="voice-panel-tool" aria-label="Dismiss" onClick={dismissVoiceError}>
            <X size={18} />
          </button>
        )}
      </div>
      {inCall && (
        <div className="voice-panel-actions">
          <Tooltip content="Turn On Camera" side="top">
            <button type="button" className="voice-panel-wide" aria-label="Turn On Camera" onClick={() => openModal({ type: "cameraPreview" })}>
              <VideoOff size={20} />
            </button>
          </Tooltip>
          <Tooltip content="Share Your Screen" side="top">
            <button type="button" className="voice-panel-wide" aria-label="Share Your Screen" onClick={() => openModal({ type: "screenShare" })}>
              <MonitorUp size={20} />
            </button>
          </Tooltip>
          <Tooltip content="Activities aren't available yet" side="top">
            <button type="button" className="voice-panel-wide" aria-label="Start An Activity" aria-disabled="true">
              <LayoutGrid size={20} />
            </button>
          </Tooltip>
          <Tooltip content={deafened ? "Soundboard is disabled while deafened" : "Open Soundboard"} side="top">
            <button
              ref={setBoardAnchor}
              type="button"
              className={`voice-panel-wide${boardOpen ? " active" : ""}${deafened ? " dim" : ""}`}
              aria-label="Open Soundboard"
              aria-haspopup="dialog"
              aria-expanded={boardOpen}
              aria-disabled={deafened || undefined}
              onClick={() => !deafened && setBoardOpen(o => !o)}
            >
              <Music size={20} />
            </button>
          </Tooltip>
        </div>
      )}
      <ConnectionPopout anchor={qualityAnchor} open={qualityOpen && inCall} onClose={() => setQualityOpen(false)} />
      <SoundboardPopout anchor={boardAnchor} open={boardOpen && inCall} onClose={() => setBoardOpen(false)} />
    </section>
  );
}
