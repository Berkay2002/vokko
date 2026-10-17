// Modals opened from the voice UI: channel status, the camera preview ("Turn On Camera" publishes the very capture shown
// here, background included) and Go Live (quality choice, then the system's own picker chooses the screen or window).

import { useState } from "react";
import { Camera, Monitor, SmilePlus, VideoOff } from "lucide-react";
import { useStore } from "../api/store";
import { closeModal } from "../shell/modalStore";
import { Dropdown, Modal, setPref, usePrefs } from "../ui";
import { ApiRequestError } from "../api/rest";
import { screenChoiceFromPrefs, setVoiceChannelStatus, startCamera, startScreenShare } from "./engine";
import { useMedia } from "./mediaStore";
import { useVoice } from "./store";
import { CAMERA_RESOLUTIONS, RESOLUTION_LABEL, SCREEN_FPS, SCREEN_RESOLUTIONS, describeScreenShare, isCameraResolution, isScreenFps, isScreenResolution, isWebKit, type CameraResolution, type ScreenFps, type ScreenResolution, type StreamContent } from "./video/options";
import { useCameraPreview } from "./video/useCameraPreview";
import { VideoBackgroundPicker } from "./video/VideoBackgroundPicker";

const STATUS_MAX = 500;

export function ChannelStatusModal({ channelId }: { channelId: string }) {
  const channel = useStore(s => s.channels[channelId]);
  const current = useVoice(s => s.channelStatus[channelId]) ?? "";
  const [text, setText] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = channel?.name ?? "this channel";
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setVoiceChannelStatus(channelId, text);
      closeModal();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Couldn't set the status. Try again.");
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={closeModal}
      title="What are we talking about?"
      className="voice-status-modal"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={closeModal}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            Set Status
          </button>
        </>
      }
    >
      <div className="voice-status-banner" aria-hidden="true" />
      <p className="modal-subtle">Let others know what you're up to in the voice channel.</p>
      <label className="field-label" htmlFor="voice-status-input">
        Status
      </label>
      <div className="voice-status-field">
        <input
          id="voice-status-input"
          className="input"
          value={text}
          maxLength={STATUS_MAX}
          placeholder={`Status for ${name}`}
          autoFocus
          onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === "Enter" && void save()}
        />
        <span className="voice-status-emoji" aria-hidden="true">
          <SmilePlus size={20} />
        </span>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

export function CameraPreviewModal() {
  const deviceId = usePrefs(s => s.cameraDevice);
  const resolutionPref = usePrefs(s => s.cameraResolution);
  const background = usePrefs(s => s.videoBackground);
  const alwaysPreview = usePrefs(s => s.alwaysPreviewVideo);
  const connected = useVoice(s => s.channelId !== null && s.status === "connected");
  const resolution: CameraResolution = isCameraResolution(resolutionPref) ? resolutionPref : "720p";
  const preview = useCameraPreview({ deviceId: deviceId === "default" ? "" : deviceId, resolution, background });
  const [busy, setBusy] = useState(false);
  const unavailable = preview.status === "blocked" || preview.status === "missing" || preview.status === "failed";

  const turnOn = async () => {
    if (busy) return;
    setBusy(true);
    // The preview's capture (already processed) is what goes out; the modal no longer owns it.
    const session = preview.take();
    closeModal();
    await startCamera(session);
  };

  return (
    <Modal
      open
      onClose={closeModal}
      title="Ready to video chat?"
      className="voice-camera-modal"
      footer={
        <>
          <label className="voice-camera-check">
            <input type="checkbox" checked={alwaysPreview} onChange={e => setPref("alwaysPreviewVideo", e.target.checked)} /> Always preview video
          </label>
          <button type="button" className="btn btn-primary" disabled={!connected || busy || unavailable} title={connected ? undefined : "Join a voice channel first"} onClick={() => void turnOn()}>
            Turn On Camera
          </button>
        </>
      }
    >
      <div className="cam-preview" data-status={preview.status}>
        <video ref={preview.videoRef} autoPlay muted playsInline aria-label="Camera preview" hidden={unavailable} />
        {unavailable && (
          <div className="cam-preview-empty">
            <VideoOff size={36} aria-hidden="true" />
            <p>
              {preview.status === "blocked"
                ? "Vokko can't use the camera. Allow camera access in your system or browser settings."
                : "No camera available. Check that a camera is connected and not in use by another app."}
            </p>
          </div>
        )}
      </div>
      <Dropdown
        label="Camera"
        icon={Camera}
        triggerClassName="voice-camera-device"
        value={deviceId === "default" ? "" : deviceId}
        options={[
          { value: "", label: "Default camera" },
          ...preview.devices.filter(d => d.deviceId && d.deviceId !== "default").map((d, i) => ({ value: d.deviceId, label: d.label || `Camera ${i + 1}` })),
        ]}
        onChange={next => setPref("cameraDevice", next || "default")}
      />
      <Dropdown
        label="Camera resolution"
        icon={Monitor}
        triggerClassName="voice-camera-device"
        value={resolution}
        options={CAMERA_RESOLUTIONS.map(r => ({ value: r, label: r === "720p" ? "720p (default)" : r }))}
        onChange={next => isCameraResolution(next) && setPref("cameraResolution", next)}
      />
      <h3 className="voice-camera-heading">Video Background</h3>
      <VideoBackgroundPicker value={background} onChange={next => setPref("videoBackground", next)} error={preview.backgroundError} />
    </Modal>
  );
}

const CONTENT_OPTIONS: { value: StreamContent; title: string; note: string }[] = [
  { value: "motion", title: "Gaming", note: "Smoother motion; resolution drops first on a weak connection" },
  { value: "detail", title: "Screen sharing", note: "Clearer text; frame rate drops first on a weak connection" },
];

const SHARE_AUDIO_NOTE = isWebKit(typeof navigator === "undefined" ? "" : navigator.userAgent)
  ? "The system's picker decides what is shared. This system can't share a screen's sound."
  : 'The system\'s picker decides what is shared. Sound comes along from a whole screen with "Share system audio" turned on, not from a single window.';

export function ScreenSharePickerModal() {
  const defaults = screenChoiceFromPrefs();
  const [resolution, setResolution] = useState<ScreenResolution>(defaults.resolution);
  const [fps, setFps] = useState<ScreenFps>(defaults.fps);
  const [audio, setAudio] = useState(defaults.audio);
  const [content, setContent] = useState<StreamContent>(defaults.content ?? (defaults.fps >= 60 ? "motion" : "detail"));
  const connected = useVoice(s => s.channelId !== null && s.status === "connected");
  const error = useMedia(s => s.error);
  const [busy, setBusy] = useState(false);

  const goLive = async () => {
    if (busy) return;
    setBusy(true);
    // Remember the choice as the new default (User Settings > Voice & Video > Streaming).
    setPref("streamResolution", resolution);
    setPref("streamFps", fps);
    setPref("streamAudio", audio);
    setPref("streamContent", content);
    closeModal();
    await startScreenShare({ resolution, fps, audio, content });
  };

  return (
    <Modal
      open
      onClose={closeModal}
      title="Share your screen"
      className="voice-share-modal"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={closeModal}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!connected || busy} title={connected ? undefined : "Join a voice channel first"} onClick={() => void goLive()}>
            Go Live
          </button>
        </>
      }
    >
      <p className="modal-subtle">Pick the quality, then choose the screen or window to share in the next step.</p>
      <div className="golive-grid">
        <div className="settings-field">
          <span className="field-label">Resolution</span>
          <Dropdown label="Resolution" className="select-wrap" triggerClassName="select" value={resolution} options={SCREEN_RESOLUTIONS.map(r => ({ value: r, label: RESOLUTION_LABEL[r] }))} onChange={next => isScreenResolution(next) && setResolution(next)} />
        </div>
        <div className="settings-field">
          <span className="field-label">Frame rate</span>
          <Dropdown label="Frame rate" className="select-wrap" triggerClassName="select" value={String(fps)} options={SCREEN_FPS.map(f => ({ value: String(f), label: `${f} fps` }))} onChange={next => isScreenFps(Number(next)) && setFps(Number(next) as ScreenFps)} />
        </div>
      </div>
      <div className="voice-share-options">
        <div className="voice-share-mode" role="radiogroup" aria-label="Stream mode">
          {CONTENT_OPTIONS.map(o => (
            <button key={o.value} type="button" role="radio" aria-checked={content === o.value} className={`voice-share-mode-option${content === o.value ? " selected" : ""}`} onClick={() => setContent(o.value)}>
              <span className="voice-share-mode-title">{o.title}</span>
              <span className="voice-share-mode-note">{o.note}</span>
            </button>
          ))}
        </div>
        <label className="voice-camera-check">
          <input type="checkbox" checked={audio} onChange={e => setAudio(e.target.checked)} /> Share audio
        </label>
      </div>
      <p className="golive-summary" aria-live="polite">
        {describeScreenShare({ resolution, fps, audio, content })} · {content === "motion" ? "Gaming" : "Screen sharing"} · {audio ? "with audio" : "no audio"}
      </p>
      <p className="golive-note">{SHARE_AUDIO_NOTE}</p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
