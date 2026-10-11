import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Camera, ChevronDown, ChevronRight, Mic, Volume2, type LucideIcon } from "lucide-react";
import { Modal, resetPrefs, setPref, usePrefs, type Prefs } from "../../ui";
import { previewSound } from "../../notify/sounds";
import { VOICE_SOUNDS, isSoundEnabled, withSoundEnabled, type VoiceSoundId } from "../../notify/soundCatalog";
import { fromSuppressionChoice, resolveAudio, suppressionChoice, type InputProfile } from "../../voice/audioProfile";
import { useMicTest } from "../../voice/micTest";
import { PttSettings } from "../../voice/PttSettings";
import { SOUNDBOARD_ROUTES_AVAILABLE } from "../../voice/soundboardSupport";
import { useVoice } from "../../voice/store";
import { sensitivityToDb } from "../../voice/vad";
import { useCameraPreview } from "../../voice/video/useCameraPreview";
import { VideoBackgroundPicker } from "../../voice/video/VideoBackgroundPicker";
import {
  CAMERA_RESOLUTIONS,
  RESOLUTION_LABEL,
  SCREEN_FPS,
  SCREEN_RESOLUTIONS,
  VIEWER_QUALITIES,
  VIEWER_QUALITY_LABEL,
  type CameraResolution,
  type ScreenFps,
  type ScreenResolution,
  type ViewerQuality,
} from "../../voice/video/options";
import { openModal } from "../modalStore";
import { Category, Divider, Field, Page, RadioGroup, Select, Slider, SwitchRow, Toggle, Unavailable } from "./controls";
import { listedDevice, useMediaDevices, type DeviceOption } from "./useMediaDevices";
import { METER_FLOOR_DB, levelToSegments, splitDeviceLabel } from "./voiceVideoHelpers";
import "./voice-video.css";

type InputModeChoice = Prefs["inputMode"];
type NoiseChoice = "none" | "standard" | "rnnoise";

const SEGMENTS = 40;
const PTT_SOUNDS: VoiceSoundId[] = ["ptt-activate", "ptt-deactivate"];

/** Every preference this page owns; "Reset Voice & Video Settings" restores exactly these. */
const VOICE_VIDEO_KEYS: (keyof Prefs)[] = [
  "inputDevice",
  "outputDevice",
  "cameraDevice",
  "inputVolume",
  "outputVolume",
  "inputMode",
  "noiseSuppression",
  "noiseSuppressionKind",
  "echoCancellation",
  "autoGainControl",
  "autoSensitivity",
  "inputSensitivity",
  "inputProfile",
  "bypassSystemProcessing",
  "alwaysPreviewVideo",
  "cameraResolution",
  "videoBackground",
  "streamResolution",
  "streamFps",
  "streamAudio",
  "viewerQuality",
  "showStreamPreviews",
  "streamAttenuation",
  "streamAttenuationStrength",
  "disabledSounds",
  "soundboardVolume",
  "debugLogging",
];

const PROFILE_CARDS: { value: InputProfile; label: string; note: string }[] = [
  { value: "isolation", label: "Voice Isolation", note: "Noise suppression, echo cancellation and automatic gain on" },
  { value: "studio", label: "Studio", note: "Your microphone as it is, with no processing" },
  { value: "custom", label: "Custom", note: "Choose each setting yourself" },
];

const NOISE_OPTIONS: { value: NoiseChoice; label: string }[] = [
  { value: "none", label: "None" },
  { value: "standard", label: "Standard" },
  { value: "rnnoise", label: "RNNoise" },
];

const QUALITY_LABEL: Record<string, string> = { excellent: "Excellent", good: "Good", poor: "Poor", lost: "Lost", unknown: "Unknown" };
const STATUS_LABEL: Record<string, string> = {
  idle: "Not connected",
  connecting: "Connecting",
  rtc_connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
};

/** Device picker: a listbox so each entry can carry an icon and a greyed driver / group name (a native <select> cannot). */
function DeviceSelect({ label, value, options, onChange, disabled, icon: Icon }: { label: string; value: string; options: DeviceOption[]; onChange(next: string): void; disabled?: boolean; icon: LucideIcon }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const selected = Math.max(0, options.findIndex(o => o.value === value));
  const current = splitDeviceLabel(options[selected]?.label ?? "Default");

  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const onDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const show = () => {
    setActive(selected);
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
    (root.current?.querySelector("button") as HTMLButtonElement | null)?.focus();
  };
  const onListKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") setActive(a => Math.min(options.length - 1, a + 1));
    else if (event.key === "ArrowUp") setActive(a => Math.max(0, a - 1));
    else if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(options.length - 1);
    else if (event.key === "Enter" || event.key === " ") choose(active);
    else if (event.key === "Escape" || event.key === "Tab") {
      setOpen(false);
      if (event.key === "Escape") (root.current?.querySelector("button") as HTMLButtonElement | null)?.focus();
    } else return;
    if (event.key !== "Tab") event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="vv-select" ref={root}>
      <button type="button" className="vv-select-button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => (open ? setOpen(false) : show())}>
        <Icon size={18} aria-hidden className="vv-select-icon" />
        <span className="vv-device-name">{current.name}</span>
        {current.detail && <span className="vv-device-detail">({current.detail})</span>}
        <ChevronDown size={18} aria-hidden className="vv-select-chevron" />
      </button>
      {open && (
        <ul ref={list} className="vv-select-list" role="listbox" tabIndex={-1} aria-label={label} aria-activedescendant={`${id}-${active}`} onKeyDown={onListKey}>
          {options.map((o, i) => {
            const parts = splitDeviceLabel(o.label);
            return (
              <li key={o.value} id={`${id}-${i}`} role="option" aria-selected={i === selected} className={`vv-select-option${i === active ? " active" : ""}${i === selected ? " selected" : ""}`} onPointerEnter={() => setActive(i)} onClick={() => choose(i)}>
                <Icon size={16} aria-hidden className="vv-select-icon" />
                <span className="vv-device-name">{parts.name}</span>
                {parts.detail && <span className="vv-device-detail">({parts.detail})</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Segmented level meter; with `threshold` set a slider sits over it so the sensitivity is set against the live signal. */
function LevelMeter({ levelDb, label, threshold, onThreshold }: { levelDb: number; label: string; threshold?: number; onThreshold?(next: number): void }) {
  const lit = levelToSegments(levelDb, SEGMENTS);
  const mark = threshold === undefined ? -1 : levelToSegments(sensitivityToDb(threshold), SEGMENTS);
  return (
    <div className="vv-meter-wrap">
      <div className="vv-meter" role="meter" aria-label={label} aria-valuemin={METER_FLOOR_DB} aria-valuemax={0} aria-valuenow={Math.round(levelDb)}>
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <span key={i} className={`vv-seg${i < lit ? (mark >= 0 && i < mark ? " below" : " on") : ""}`} />
        ))}
      </div>
      {threshold !== undefined && onThreshold && (
        <input type="range" className="vv-threshold" aria-label="Input sensitivity" aria-valuetext={`${threshold}%`} min={0} max={100} value={threshold} onChange={e => onThreshold(Number(e.target.value))} />
      )}
    </div>
  );
}

function Expander({ label, open, onToggle, controls }: { label: string; open: boolean; onToggle(): void; controls: string }) {
  return (
    <button type="button" className="vv-expander" aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      <span className="vv-expander-chevron" aria-hidden>
        {open ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
      </span>
      <span>{label}</span>
    </button>
  );
}

function ResetDialog({ onClose }: { onClose(): void }) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Reset Voice & Video Settings"
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              resetPrefs(VOICE_VIDEO_KEYS);
              onClose();
            }}
          >
            Reset
          </button>
        </>
      }
    >
      <p className="modal-text">Devices, volumes, input mode, noise settings, camera, streaming defaults and sounds go back to their defaults. This cannot be undone.</p>
    </Modal>
  );
}

export function VoiceVideoPage() {
  const inputDevice = usePrefs(s => s.inputDevice);
  const outputDevice = usePrefs(s => s.outputDevice);
  const cameraDevice = usePrefs(s => s.cameraDevice);
  const inputVolume = usePrefs(s => s.inputVolume);
  const outputVolume = usePrefs(s => s.outputVolume);
  const inputMode = usePrefs(s => s.inputMode);
  const inputProfile = usePrefs(s => s.inputProfile);
  const noiseSuppression = usePrefs(s => s.noiseSuppression);
  const noiseKind = usePrefs(s => s.noiseSuppressionKind);
  const echoCancellation = usePrefs(s => s.echoCancellation);
  const autoGainControl = usePrefs(s => s.autoGainControl);
  const bypass = usePrefs(s => s.bypassSystemProcessing);
  const autoSensitivity = usePrefs(s => s.autoSensitivity);
  const sensitivity = usePrefs(s => s.inputSensitivity);
  const alwaysPreview = usePrefs(s => s.alwaysPreviewVideo);
  const cameraResolution = usePrefs(s => s.cameraResolution);
  const videoBackground = usePrefs(s => s.videoBackground);
  const streamResolution = usePrefs(s => s.streamResolution);
  const streamFps = usePrefs(s => s.streamFps);
  const streamAudio = usePrefs(s => s.streamAudio);
  const viewerQuality = usePrefs(s => s.viewerQuality);
  const showPreviews = usePrefs(s => s.showStreamPreviews);
  const attenuation = usePrefs(s => s.streamAttenuation);
  const attenuationStrength = usePrefs(s => s.streamAttenuationStrength);
  const disabledSounds = usePrefs(s => s.disabledSounds);
  const soundboardVolume = usePrefs(s => s.soundboardVolume);
  const debugLogging = usePrefs(s => s.debugLogging);

  const voiceStatus = useVoice(s => s.status);
  const voiceQuality = useVoice(s => s.quality);
  const pingMs = useVoice(s => s.pingMs);

  const devices = useMediaDevices();
  const mic = useMicTest();
  const [troubleshoot, setTroubleshoot] = useState(false);
  const [advancedVoice, setAdvancedVoice] = useState(false);
  const [advancedStream, setAdvancedStream] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false);
  const [moreSounds, setMoreSounds] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [previewOn, setPreviewOn] = useState(false);
  const ids = useId();

  // Device names appear once a permission has been granted, which the mic test or camera test does.
  const { refresh } = devices;
  useEffect(() => {
    if (mic.testing || previewOn) void refresh();
  }, [mic.testing, previewOn, refresh]);

  const camera = useCameraPreview({
    enabled: previewOn,
    deviceId: cameraDevice === "default" ? "" : cameraDevice,
    resolution: (cameraResolution === "1080p" ? "1080p" : "720p") as CameraResolution,
    background: videoBackground,
  });

  const resolved = resolveAudio({ inputProfile, noiseSuppression, noiseSuppressionKind: noiseKind, echoCancellation, autoGainControl, bypassSystemProcessing: bypass });
  const custom = inputProfile === "custom";
  const noiseValue: NoiseChoice = custom ? suppressionChoice(noiseSuppression, noiseKind) : resolved.rnnoise ? "rnnoise" : resolved.noiseSuppression ? "standard" : "none";
  const pttSoundOn = PTT_SOUNDS.every(id => isSoundEnabled(disabledSounds, id));
  const primarySounds = VOICE_SOUNDS.filter(s => s.group === "primary");
  const moreList = VOICE_SOUNDS.filter(s => s.group === "more");
  const shownSounds = moreSounds ? VOICE_SOUNDS : primarySounds;

  const setSound = (id: VoiceSoundId, on: boolean) => setPref("disabledSounds", withSoundEnabled(getDisabled(), id, on));
  // Read the freshest value so toggling two sounds in a row does not overwrite the first change.
  const getDisabled = () => usePrefs.getState().disabledSounds;

  const cameraEmpty =
    camera.status === "blocked"
      ? "Camera access is blocked. Allow it in your browser or system settings."
      : camera.status === "missing"
        ? "No camera was found."
        : camera.status === "failed"
          ? "The camera could not be started."
          : null;

  const noAccess = !devices.apiOk;

  return (
    <Page title="Voice & Video">
      <Category title="Voice">
        {noAccess && <Unavailable>Audio devices cannot be listed here, so only the default device is shown.</Unavailable>}
        <div className="vv-columns">
          <Field label="Microphone">
            <DeviceSelect label="Microphone" icon={Mic} value={listedDevice(devices.inputs, inputDevice)} options={devices.inputs} onChange={v => setPref("inputDevice", v)} disabled={noAccess} />
          </Field>
          <Field label="Speaker">
            <DeviceSelect label="Speaker" icon={Volume2} value={listedDevice(devices.outputs, outputDevice)} options={devices.outputs} onChange={v => setPref("outputDevice", v)} disabled={noAccess} />
          </Field>
        </div>
        {devices.noLabels && <div className="settings-field-note vv-gap">Start a microphone test to see device names.</div>}
        <div className="vv-columns">
          <Field label="Input volume">
            <Slider label="Input volume" value={inputVolume} min={0} max={200} onChange={v => setPref("inputVolume", v)} format={v => `${v}%`} />
          </Field>
          <Field label="Output volume">
            <Slider label="Output volume" value={outputVolume} min={0} max={200} onChange={v => setPref("outputVolume", v)} format={v => `${v}%`} />
          </Field>
        </div>

        <Field label="Mic test" note="Plays your microphone back through the speaker so you hear what others hear. Use headphones to avoid feedback. Nothing is recorded or sent.">
          <div className="vv-test-row">
            <button type="button" className="sp-button" disabled={noAccess} onClick={mic.toggle}>
              {mic.testing ? "Stop Testing" : "Let's Check"}
            </button>
            <LevelMeter levelDb={mic.levelDb} label="Microphone level" />
          </div>
          {mic.error && (
            <div className="settings-field-note vv-error" role="alert">
              {mic.error}
            </div>
          )}
        </Field>
        <div className="vv-link-row">
          <button type="button" className="vv-link" aria-expanded={troubleshoot} aria-controls={`${ids}-trouble`} onClick={() => setTroubleshoot(t => !t)}>
            Voice troubleshooting
          </button>
        </div>
        {troubleshoot && (
          <ul id={`${ids}-trouble`} className="vv-trouble">
            <li>Check that the right microphone and speaker are selected above.</li>
            <li>Check that your system lets Vokko use the microphone (Privacy settings of your operating system or browser).</li>
            <li>Try the Studio input profile if Voice Isolation cuts you off.</li>
          </ul>
        )}

        <Divider />
        <Field label="Input profile">
          <div className="vv-profiles" role="radiogroup" aria-label="Input profile">
            {PROFILE_CARDS.map(card => (
              <button key={card.value} type="button" role="radio" aria-checked={inputProfile === card.value} className={`vv-profile${inputProfile === card.value ? " selected" : ""}`} onClick={() => setPref("inputProfile", card.value)}>
                <span className="vv-profile-label">{card.label}</span>
                <span className="vv-profile-note">{card.note}</span>
              </button>
            ))}
          </div>
        </Field>

        <Field label="Input mode">
          <RadioGroup<InputModeChoice>
            name="Input mode"
            value={inputMode}
            onChange={v => setPref("inputMode", v)}
            options={[
              { value: "vad", label: "Voice Activity" },
              { value: "ptt", label: "Push to Talk" },
            ]}
          />
        </Field>
        {inputMode === "ptt" && (
          <>
            <PttSettings />
            <SwitchRow label="Push to talk sound" note="Plays a short sound when push to talk turns on and off." checked={pttSoundOn} onChange={on => PTT_SOUNDS.forEach(id => setSound(id, on))} />
          </>
        )}

        <Field label="Input sensitivity" note={mic.testing ? undefined : "Press Let's Check to see your level"}>
          <SwitchRow label="Automatically determine input sensitivity" checked={autoSensitivity} onChange={v => setPref("autoSensitivity", v)} />
          <div className="vv-sensitivity">
            <LevelMeter levelDb={mic.levelDb} label="Input level" threshold={autoSensitivity ? undefined : sensitivity} onThreshold={v => setPref("inputSensitivity", v)} />
          </div>
        </Field>

        <Field label="Noise suppression" note={noiseValue === "rnnoise" ? "Removes keyboard and fan noise with a small neural model" : undefined}>
          <Select<NoiseChoice>
            label="Noise suppression"
            value={noiseValue}
            options={NOISE_OPTIONS}
            disabled={!custom}
            onChange={v => {
              const next = fromSuppressionChoice(v, noiseKind);
              setPref("noiseSuppression", next.noiseSuppression);
              setPref("noiseSuppressionKind", next.noiseSuppressionKind);
            }}
          />
        </Field>
        <SwitchRow label="Echo cancellation" checked={custom ? echoCancellation : resolved.echoCancellation} disabled={!custom} onChange={v => setPref("echoCancellation", v)} />

        <Expander label="Show advanced voice settings" open={advancedVoice} onToggle={() => setAdvancedVoice(o => !o)} controls={`${ids}-advvoice`} />
        {advancedVoice && (
          <div id={`${ids}-advvoice`} className="vv-expanded">
            <SwitchRow label="Automatic Gain Control" checked={custom ? autoGainControl : resolved.autoGainControl} disabled={!custom} onChange={v => setPref("autoGainControl", v)} />
            <SwitchRow label="Advanced Voice Activity" note="Not available yet: needs voice detection from the noise suppressor" checked={false} disabled onChange={() => undefined} />
            <SwitchRow label="Bypass System Input Processing" note="Asks for the raw microphone signal with no echo, noise or gain processing from the system." checked={bypass} onChange={v => setPref("bypassSystemProcessing", v)} />
            <SwitchRow label="Attenuation" note="Lowering other apps needs OS integration that the desktop client does not have yet" checked={false} disabled onChange={() => undefined} />
            <SwitchRow label="Skip QoS packet priority" note="Packet priority marking is not available in a webview" checked={false} disabled onChange={() => undefined} />
          </div>
        )}
      </Category>

      <Category title="Camera">
        <div className="vv-camera">
          <div className="cam-preview">
            {previewOn && cameraEmpty === null && <video ref={camera.videoRef} autoPlay muted playsInline aria-label="Camera preview" />}
            {(!previewOn || cameraEmpty !== null || camera.status === "starting") && (
              <div className="cam-preview-empty">
                <Camera size={28} aria-hidden />
                <p>{!previewOn ? "Camera preview is off" : camera.status === "starting" ? "Starting camera..." : cameraEmpty}</p>
              </div>
            )}
          </div>
          <div className="sp-actions">
            <button type="button" className="sp-button" disabled={noAccess} onClick={() => setPreviewOn(p => !p)}>
              {previewOn ? "Stop Test" : "Test Video"}
            </button>
          </div>
        </div>
        <SwitchRow label="Always preview video" note="Show a camera preview before you turn your camera on in a call." checked={alwaysPreview} onChange={v => setPref("alwaysPreviewVideo", v)} />
        <div className="vv-columns">
          <Field label="Camera">
            <DeviceSelect label="Camera" icon={Camera} value={listedDevice(devices.cameras, cameraDevice)} options={devices.cameras} onChange={v => setPref("cameraDevice", v)} disabled={noAccess} />
          </Field>
          <Field label="Resolution">
            <Select<CameraResolution>
              label="Camera resolution"
              value={cameraResolution === "1080p" ? "1080p" : "720p"}
              options={CAMERA_RESOLUTIONS.map(r => ({ value: r, label: r === "720p" ? "720p (default)" : r }))}
              onChange={v => setPref("cameraResolution", v)}
            />
          </Field>
        </div>
        <Field label="Video background">
          <VideoBackgroundPicker value={videoBackground} onChange={v => setPref("videoBackground", v)} error={camera.backgroundError} />
        </Field>
      </Category>

      <Category title="Streaming">
        <SwitchRow
          label="Show stream previews"
          note="Shows a small preview of live streams in the channel list. Stream previews need server support that is not available yet, so this only affects this device."
          checked={showPreviews}
          onChange={v => setPref("showStreamPreviews", v)}
        />
        <Expander label="Show advanced stream settings" open={advancedStream} onToggle={() => setAdvancedStream(o => !o)} controls={`${ids}-advstream`} />
        {advancedStream && (
          <div id={`${ids}-advstream`} className="vv-expanded">
            <SwitchRow label="Stream attenuation" note="Lowers other voices on your device while you watch a stream" checked={attenuation} onChange={v => setPref("streamAttenuation", v)} />
            <Field label="Attenuation strength">
              <Slider label="Attenuation strength" value={attenuationStrength} min={0} max={100} disabled={!attenuation} onChange={v => setPref("streamAttenuationStrength", v)} format={v => `${v}%`} />
            </Field>
            <Divider />
            <div className="vv-sub-title">Default stream quality</div>
            <div className="vv-columns">
              <Field label="Resolution">
                <Select<ScreenResolution>
                  label="Stream resolution"
                  value={(SCREEN_RESOLUTIONS as readonly string[]).includes(streamResolution) ? (streamResolution as ScreenResolution) : "1080p"}
                  options={SCREEN_RESOLUTIONS.map(r => ({ value: r, label: RESOLUTION_LABEL[r] }))}
                  onChange={v => setPref("streamResolution", v)}
                />
              </Field>
              <Field label="Frame rate">
                <Select<string>
                  label="Stream frame rate"
                  value={String((SCREEN_FPS as readonly number[]).includes(streamFps) ? streamFps : 30)}
                  options={SCREEN_FPS.map((f: ScreenFps) => ({ value: String(f), label: `${f} fps` }))}
                  onChange={v => setPref("streamFps", Number(v))}
                />
              </Field>
            </div>
            <SwitchRow label="Share audio" note="Include the sound of the shared window or screen." checked={streamAudio} onChange={v => setPref("streamAudio", v)} />
            <Field label="Watching quality">
              <Select<ViewerQuality>
                label="Watching quality"
                value={(VIEWER_QUALITIES as readonly string[]).includes(viewerQuality) ? (viewerQuality as ViewerQuality) : "auto"}
                options={VIEWER_QUALITIES.map(q => ({ value: q, label: VIEWER_QUALITY_LABEL[q] }))}
                onChange={v => setPref("viewerQuality", v)}
              />
            </Field>
          </div>
        )}
      </Category>

      <Category title="Sounds">
        <div className="vv-sounds">
          {shownSounds.map(s => (
            <SoundRow key={s.id} label={s.label} enabled={isSoundEnabled(disabledSounds, s.id)} onPreview={() => previewSound(s.id)} onChange={on => setSound(s.id, on)} />
          ))}
        </div>
        {moreList.length > 0 && (
          <button type="button" className="vv-link" aria-expanded={moreSounds} onClick={() => setMoreSounds(m => !m)}>
            {moreSounds ? "Show less" : `Show ${moreList.length} more`}
          </button>
        )}
        <div className="settings-field-note vv-gap">
          Message and mention sounds are in{" "}
          <button type="button" className="vv-link vv-inline" onClick={() => openModal({ type: "userSettings", section: "notifications" })}>
            Notifications settings
          </button>
          .
        </div>
      </Category>

      <Category title="Soundboard">
        <Field label="Soundboard volume">
          <Slider label="Soundboard volume" value={soundboardVolume} min={0} max={100} onChange={v => setPref("soundboardVolume", v)} format={v => `${v}%`} />
        </Field>
        <div className="vv-columns">
          <Field label="Server">
            <Select<string> label="Entrance sound server" value="all" options={[{ value: "all", label: "All servers" }]} disabled={!SOUNDBOARD_ROUTES_AVAILABLE} onChange={() => undefined} />
          </Field>
          <Field label="Sound">
            <Select<string> label="Entrance sound" value="none" options={[{ value: "none", label: "None" }]} disabled={!SOUNDBOARD_ROUTES_AVAILABLE} onChange={() => undefined} />
          </Field>
        </div>
        {!SOUNDBOARD_ROUTES_AVAILABLE && <div className="settings-field-note">Entrance sounds are coming soon.</div>}
      </Category>

      <Category title="Advanced">
        <Expander label="Show diagnostic settings" open={diagnostics} onToggle={() => setDiagnostics(o => !o)} controls={`${ids}-diag`} />
        {diagnostics && (
          <div id={`${ids}-diag`} className="vv-expanded">
            <SwitchRow label="Debug logging" note="Writes voice connection events and WebRTC statistics to the developer console" checked={debugLogging} onChange={v => setPref("debugLogging", v)} />
            <Field label="Connection">
              <dl className="vv-stats">
                <dt>Status</dt>
                <dd>{STATUS_LABEL[voiceStatus] ?? voiceStatus}</dd>
                <dt>Quality</dt>
                <dd>{QUALITY_LABEL[voiceQuality] ?? voiceQuality}</dd>
                <dt>Ping</dt>
                <dd>{pingMs === null ? "Not available" : `${Math.round(pingMs)} ms`}</dd>
              </dl>
            </Field>
          </div>
        )}
        <Divider />
        <div className="sp-actions">
          <button type="button" className="btn btn-danger" onClick={() => setConfirmReset(true)}>
            Reset Voice &amp; Video Settings
          </button>
        </div>
      </Category>
      {confirmReset && <ResetDialog onClose={() => setConfirmReset(false)} />}
    </Page>
  );
}

function SoundRow({ label, enabled, onPreview, onChange }: { label: string; enabled: boolean; onPreview(): void; onChange(next: boolean): void }): ReactNode {
  return (
    <div className="switch-row vv-sound-row">
      <div className="switch-row-text">
        <div className="switch-row-label">{label}</div>
      </div>
      <button type="button" className="vv-preview" aria-label={`Preview ${label}`} onClick={onPreview}>
        Preview
      </button>
      <Toggle checked={enabled} onChange={onChange} label={label} />
    </div>
  );
}
