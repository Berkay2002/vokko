import { useCallback, useEffect, useRef, useState } from "react";
import { setPref, usePrefs } from "../../ui";
import type { InputMode } from "../../ui/prefs";
import { Category, Divider, Field, Page, RadioGroup, Select, Slider, SwitchRow, Unavailable } from "./controls";

interface Device {
  value: string;
  label: string;
}

interface DeviceLists {
  inputs: Device[];
  outputs: Device[];
  cameras: Device[];
}

const DEFAULT_DEVICE: Device = { value: "default", label: "Default" };
const EMPTY_LISTS: DeviceLists = { inputs: [DEFAULT_DEVICE], outputs: [DEFAULT_DEVICE], cameras: [DEFAULT_DEVICE] };

function hasMediaApi(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === "function";
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach(t => t.stop());
}

function toOptions(devices: MediaDeviceInfo[], kind: MediaDeviceKind): Device[] {
  const list = devices
    .filter(d => d.kind === kind && d.deviceId !== "default" && d.deviceId !== "")
    .map((d, i) => ({ value: d.deviceId, label: d.label || `Device ${i + 1}` }));
  return [DEFAULT_DEVICE, ...list];
}

function withCurrent(list: Device[], current: string): string {
  return list.some(d => d.value === current) ? current : "default";
}

export function VoiceVideoPage() {
  const inputDevice = usePrefs(s => s.inputDevice);
  const outputDevice = usePrefs(s => s.outputDevice);
  const cameraDevice = usePrefs(s => s.cameraDevice);
  const inputVolume = usePrefs(s => s.inputVolume);
  const outputVolume = usePrefs(s => s.outputVolume);
  const inputMode = usePrefs(s => s.inputMode);
  const autoSensitivity = usePrefs(s => s.autoSensitivity);
  const sensitivity = usePrefs(s => s.inputSensitivity);
  const noiseSuppression = usePrefs(s => s.noiseSuppression);
  const echoCancellation = usePrefs(s => s.echoCancellation);
  const autoGainControl = usePrefs(s => s.autoGainControl);

  const [lists, setLists] = useState<DeviceLists>(EMPTY_LISTS);
  const [apiOk] = useState(hasMediaApi);
  const [error, setError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const micRef = useRef<{ stream: MediaStream; ctx: AudioContext; raf: number } | null>(null);

  const [previewing, setPreviewing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const camStreamRef = useRef<MediaStream | null>(null);

  const refresh = useCallback(async () => {
    if (!hasMediaApi()) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setLists({ inputs: toOptions(devices, "audioinput"), outputs: toOptions(devices, "audiooutput"), cameras: toOptions(devices, "videoinput") });
    } catch {
      setLists(EMPTY_LISTS);
    }
  }, []);

  useEffect(() => {
    if (!hasMediaApi()) return;
    void refresh();
    const md = navigator.mediaDevices;
    md.addEventListener("devicechange", refresh);
    return () => md.removeEventListener("devicechange", refresh);
  }, [refresh]);

  const stopMic = useCallback(() => {
    const m = micRef.current;
    if (!m) return;
    cancelAnimationFrame(m.raf);
    stopStream(m.stream);
    void m.ctx.close().catch(() => undefined);
    micRef.current = null;
    setTesting(false);
    setLevel(0);
  }, []);

  const stopCamera = useCallback(() => {
    stopStream(camStreamRef.current);
    camStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setPreviewing(false);
  }, []);

  // Never leave a stream running after the page unmounts.
  useEffect(
    () => () => {
      const m = micRef.current;
      if (m) {
        cancelAnimationFrame(m.raf);
        stopStream(m.stream);
        void m.ctx.close().catch(() => undefined);
        micRef.current = null;
      }
      stopStream(camStreamRef.current);
      camStreamRef.current = null;
    },
    [],
  );

  const allowMic = async () => {
    setError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      stopStream(s);
      await refresh();
    } catch {
      setError("Microphone access was not granted.");
    }
  };

  const toggleMicTest = async () => {
    if (micRef.current) {
      stopMic();
      return;
    }
    setError(null);
    try {
      const constraints: MediaTrackConstraints = { noiseSuppression, echoCancellation, autoGainControl };
      if (inputDevice !== "default") constraints.deviceId = { exact: inputDevice };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const state = { stream, ctx, raf: 0 };
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(Math.min(100, Math.round((peak / 128) * 100)));
        state.raf = requestAnimationFrame(tick);
      };
      state.raf = requestAnimationFrame(tick);
      micRef.current = state;
      setTesting(true);
      void refresh();
    } catch {
      setError("Could not start the microphone test.");
    }
  };

  const toggleCamera = async () => {
    if (camStreamRef.current) {
      stopCamera();
      return;
    }
    setError(null);
    try {
      const video: MediaTrackConstraints = cameraDevice !== "default" ? { deviceId: { exact: cameraDevice } } : {};
      const stream = await navigator.mediaDevices.getUserMedia({ video });
      camStreamRef.current = stream;
      setPreviewing(true);
      void refresh();
    } catch {
      setError("Could not start the camera.");
    }
  };

  // Attach the stream once the <video> element has rendered.
  useEffect(() => {
    if (previewing && videoRef.current && camStreamRef.current) {
      videoRef.current.srcObject = camStreamRef.current;
      void videoRef.current.play().catch(() => undefined);
    }
  }, [previewing]);

  const noLabels = apiOk && lists.inputs.length > 1 && lists.inputs.every(d => d.label.startsWith("Device "));

  return (
    <Page title="Voice & Video">
      <Category title="Voice">
        {!apiOk && <Unavailable>Audio devices cannot be listed here, so only the default device is shown.</Unavailable>}
        <div className="voice-device-row">
          <Field label="Input device">
            <Select<string> label="Input device" value={withCurrent(lists.inputs, inputDevice)} options={lists.inputs} onChange={v => setPref("inputDevice", v)} disabled={!apiOk} />
          </Field>
          <Field label="Output device">
            <Select<string> label="Output device" value={withCurrent(lists.outputs, outputDevice)} options={lists.outputs} onChange={v => setPref("outputDevice", v)} disabled={!apiOk} />
          </Field>
        </div>
        {apiOk && (
          <div className="sp-actions">
            <button type="button" className="sp-button" onClick={() => void allowMic()}>
              Allow microphone access
            </button>
            {noLabels && <span className="settings-field-note">Allow access to see device names.</span>}
          </div>
        )}
        <div className="voice-device-row">
          <Field label="Input volume">
            <Slider label="Input volume" value={inputVolume} min={0} max={100} onChange={v => setPref("inputVolume", v)} format={v => `${v}%`} />
          </Field>
          <Field label="Output volume">
            <Slider label="Output volume" value={outputVolume} min={0} max={100} onChange={v => setPref("outputVolume", v)} format={v => `${v}%`} />
          </Field>
        </div>
        <Field label="Mic test" note="Speak and watch the meter. Nothing is recorded or sent.">
          <div className="sp-actions">
            <button type="button" className="sp-button" disabled={!apiOk} onClick={() => void toggleMicTest()}>
              {testing ? "Stop testing" : "Let's check"}
            </button>
            <div className="mic-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={level}>
              <div className="mic-meter-fill" style={{ width: `${level}%` }} />
            </div>
          </div>
        </Field>
        {error && <div className="settings-field-note" role="alert">{error}</div>}
        <Divider />
        <Field label="Input mode">
          <RadioGroup<InputMode>
            name="Input mode"
            value={inputMode}
            onChange={v => setPref("inputMode", v)}
            options={[
              { value: "vad", label: "Voice Activity" },
              { value: "ptt", label: "Push to Talk" },
            ]}
          />
        </Field>
        <SwitchRow label="Automatically determine input sensitivity" checked={autoSensitivity} onChange={v => setPref("autoSensitivity", v)} />
        <Field label="Input sensitivity">
          <Slider label="Input sensitivity" value={sensitivity} min={0} max={100} disabled={autoSensitivity} onChange={v => setPref("inputSensitivity", v)} format={v => `${v}%`} />
        </Field>
      </Category>

      <Category title="Camera">
        <Field label="Camera">
          <Select<string> label="Camera" value={withCurrent(lists.cameras, cameraDevice)} options={lists.cameras} onChange={v => setPref("cameraDevice", v)} disabled={!apiOk} />
        </Field>
        <div className="camera-preview">
          {previewing ? <video ref={videoRef} muted playsInline aria-label="Camera preview" /> : <span>Camera preview is off</span>}
        </div>
        <div className="sp-actions">
          <button type="button" className="sp-button" disabled={!apiOk} onClick={() => void toggleCamera()}>
            {previewing ? "Stop Video" : "Test Video"}
          </button>
        </div>
      </Category>

      <Category title="Advanced">
        <SwitchRow label="Noise suppression" checked={noiseSuppression} onChange={v => setPref("noiseSuppression", v)} />
        <SwitchRow label="Echo cancellation" checked={echoCancellation} onChange={v => setPref("echoCancellation", v)} />
        <SwitchRow label="Automatic gain control" checked={autoGainControl} onChange={v => setPref("autoGainControl", v)} />
      </Category>
    </Page>
  );
}
