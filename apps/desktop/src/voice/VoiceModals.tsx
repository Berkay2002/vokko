// Modals opened from the voice UI: channel status, camera preview (device preview only: the camera in calls is V2) and
// the screen share picker shell (sharing is V3; the webview cannot list windows yet).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppWindow, Cable, Camera, ChevronDown, Monitor, SmilePlus, VideoOff } from "lucide-react";
import { useStore } from "../api/store";
import { closeModal } from "../shell/modalStore";
import { Modal } from "../ui";
import { ApiRequestError } from "../api/rest";
import { setVoiceChannelStatus } from "./engine";
import { useVoice } from "./store";

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

type Background = "none" | "blur" | "custom";

export function CameraPreviewModal() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [background, setBackground] = useState<Background>("none");
  const [alwaysPreview, setAlwaysPreview] = useState(true);
  const video = useRef<HTMLVideoElement>(null);

  // Preview the selected camera locally (nothing is sent anywhere); stop every track when the modal closes or the device changes.
  useEffect(() => {
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!media?.getUserMedia) {
      setBlocked(true);
      return;
    }
    let stream: MediaStream | null = null;
    let live = true;
    media
      .getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : true })
      .then(async s => {
        if (!live) return s.getTracks().forEach(t => t.stop());
        stream = s;
        setBlocked(false);
        if (video.current) video.current.srcObject = s;
        const list = await media.enumerateDevices();
        if (live) setDevices(list.filter(d => d.kind === "videoinput"));
      })
      .catch(() => live && setBlocked(true));
    return () => {
      live = false;
      stream?.getTracks().forEach(t => t.stop());
    };
  }, [deviceId]);

  return (
    <Modal
      open
      onClose={closeModal}
      title="Ready to video chat?"
      className="voice-camera-modal"
      footer={
        <>
          <label className="voice-camera-check">
            <input type="checkbox" checked={alwaysPreview} onChange={e => setAlwaysPreview(e.target.checked)} /> Always preview video
          </label>
          <button type="button" className="btn btn-primary" disabled title="Video in calls arrives in a later update">
            Turn On Camera
          </button>
        </>
      }
    >
      <div className="voice-camera-preview">
        {blocked ? (
          <div className="voice-camera-empty">
            <VideoOff size={36} aria-hidden="true" />
            <p>No camera available. Check that a camera is connected and that access is allowed.</p>
          </div>
        ) : (
          <video ref={video} className={`voice-camera-video${background === "blur" ? " blur" : ""}`} autoPlay muted playsInline />
        )}
      </div>
      <div className="voice-camera-device">
        <Camera size={16} aria-hidden="true" />
        <select aria-label="Camera" className="voice-camera-select" value={deviceId} onChange={e => setDeviceId(e.target.value)}>
          <option value="">Default camera</option>
          {devices.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Camera ${i + 1}`}
            </option>
          ))}
        </select>
        <ChevronDown size={16} aria-hidden="true" />
      </div>
      <h3 className="voice-camera-heading">Video Background</h3>
      <div className="voice-camera-backgrounds" role="radiogroup" aria-label="Video background">
        {(
          [
            ["none", "None"],
            ["blur", "Blur"],
            ["custom", "Custom"],
          ] as [Background, string][]
        ).map(([value, label]) => (
          <button key={value} type="button" role="radio" aria-checked={background === value} className={`voice-camera-bg${background === value ? " selected" : ""}`} onClick={() => setBackground(value)}>
            {label}
          </button>
        ))}
      </div>
    </Modal>
  );
}

type PickerTab = "apps" | "screen" | "devices";

export function ScreenSharePickerModal() {
  const [tab, setTab] = useState<PickerTab>("apps");
  const [mode, setMode] = useState<"gaming" | "text">("gaming");
  const [hd, setHd] = useState(false);
  const tabs: { id: PickerTab; label: string; icon: ReactNode }[] = [
    { id: "apps", label: "Applications", icon: <AppWindow size={16} /> },
    { id: "screen", label: "Entire Screen", icon: <Monitor size={16} /> },
    { id: "devices", label: "Devices", icon: <Cable size={16} /> },
  ];
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
          <button type="button" className="btn btn-primary" disabled title="Screen sharing arrives in a later update">
            Go Live
          </button>
        </>
      }
    >
      <div className="voice-share-tabs" role="tablist">
        {tabs.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`voice-share-tab${tab === t.id ? " selected" : ""}`} onClick={() => setTab(t.id)}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>
      <div className="voice-share-empty" role="tabpanel">
        <Monitor size={36} aria-hidden="true" />
        <p>Choosing a window or screen to share needs the desktop app, which is coming in a later update.</p>
      </div>
      <div className="voice-share-options">
        <div className="voice-share-mode" role="radiogroup" aria-label="Stream mode">
          <button type="button" role="radio" aria-checked={mode === "gaming"} className={`voice-share-mode-option${mode === "gaming" ? " selected" : ""}`} onClick={() => setMode("gaming")}>
            <span className="voice-share-mode-title">Gaming</span>
            <span className="voice-share-mode-note">Smoother video · 720p · 30 fps</span>
          </button>
          <button type="button" role="radio" aria-checked={mode === "text"} className={`voice-share-mode-option${mode === "text" ? " selected" : ""}`} onClick={() => setMode("text")}>
            <span className="voice-share-mode-title">Screen sharing</span>
            <span className="voice-share-mode-note">Clearer text · source · 5 fps</span>
          </button>
        </div>
        <label className="voice-camera-check">
          <input type="checkbox" checked={hd} onChange={e => setHd(e.target.checked)} /> HD (1080p, 60 fps)
        </label>
      </div>
    </Modal>
  );
}
