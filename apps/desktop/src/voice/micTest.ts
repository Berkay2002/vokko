// "Let's Check" mic test of User Settings > Voice & Video: the same input chain the call uses (RNNoise, level tap, input
// volume) with the result looped back to the chosen output device so the user hears what others would. Nothing is
// recorded or sent. Not unit tested (Web Audio); the pure helpers live in shell/settings/voiceVideoHelpers.ts.

import { useCallback, useEffect, useRef, useState } from "react";
import { usePrefs } from "../ui";
import { resolveAudio } from "./audioProfile";
import { resolveDeviceId, withDeviceFallback } from "./devices";
import { InputChain } from "./inputChain";
import { RNNOISE_RATE } from "./rnnoise";

export const SILENT_DB = -100;

interface Session {
  stream: MediaStream;
  ctx: AudioContext;
  chain: InputChain;
  outGain: GainNode;
  dest: MediaStreamAudioDestinationNode;
  element: HTMLAudioElement | null;
}

export interface MicTest {
  testing: boolean;
  /** Level of the processed microphone in dBFS (-100 while not testing). */
  levelDb: number;
  error: string | null;
  toggle(): void;
  stop(): void;
}

function openContext(rnnoise: boolean): AudioContext {
  if (rnnoise) {
    try {
      return new AudioContext({ sampleRate: RNNOISE_RATE });
    } catch {
      // fall through: RNNoise reports itself unavailable and the chain runs without it
    }
  }
  return new AudioContext();
}

function teardown(session: Session): void {
  session.chain.destroy();
  session.outGain.disconnect();
  session.dest.disconnect();
  session.stream.getTracks().forEach(t => t.stop());
  if (session.element) {
    session.element.pause();
    session.element.srcObject = null;
  }
  void session.ctx.close().catch(() => undefined);
}

export function useMicTest(): MicTest {
  const inputDevice = usePrefs(s => s.inputDevice);
  const outputDevice = usePrefs(s => s.outputDevice);
  const inputVolume = usePrefs(s => s.inputVolume);
  const outputVolume = usePrefs(s => s.outputVolume);
  const inputProfile = usePrefs(s => s.inputProfile);
  const noiseSuppression = usePrefs(s => s.noiseSuppression);
  const noiseSuppressionKind = usePrefs(s => s.noiseSuppressionKind);
  const echoCancellation = usePrefs(s => s.echoCancellation);
  const autoGainControl = usePrefs(s => s.autoGainControl);
  const bypassSystemProcessing = usePrefs(s => s.bypassSystemProcessing);

  const [testing, setTesting] = useState(false);
  const [levelDb, setLevelDb] = useState(SILENT_DB);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const latest = useRef(SILENT_DB);
  // Bumped on every start / stop so a start that finishes after a stop cleans up after itself.
  const generation = useRef(0);

  const resolved = resolveAudio({ inputProfile, noiseSuppression, noiseSuppressionKind, echoCancellation, autoGainControl, bypassSystemProcessing });
  const configKey = `${inputDevice}|${outputDevice}|${resolved.echoCancellation}|${resolved.noiseSuppression}|${resolved.autoGainControl}|${resolved.rnnoise}`;

  const stop = useCallback(() => {
    generation.current++;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) teardown(session);
    latest.current = SILENT_DB;
    setLevelDb(SILENT_DB);
    setTesting(false);
  }, []);

  const start = useCallback(async () => {
    const mine = ++generation.current;
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      setError("Microphone testing is not available here.");
      return;
    }
    const { echoCancellation: echo, noiseSuppression: noise, autoGainControl: agc, rnnoise } = resolved;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
      const wanted = resolveDeviceId(inputDevice, devices.filter(d => d.kind === "audioinput"));
      const opened = await withDeviceFallback(wanted, id =>
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: echo, noiseSuppression: noise, autoGainControl: agc, ...(id !== "default" ? { deviceId: { exact: id } } : {}) },
        }),
      );
      stream = opened.result;
      if (mine !== generation.current) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      ctx = openContext(rnnoise);
      const source = ctx.createMediaStreamSource(stream);
      const chain = await InputChain.create(ctx, source, { gain: inputVolume / 100, rnnoise, onLevel: db => (latest.current = db) });
      const outGain = ctx.createGain();
      outGain.gain.value = outputVolume / 100;
      const dest = ctx.createMediaStreamDestination();
      chain.output.connect(outGain);
      const session: Session = { stream, ctx, chain, outGain, dest, element: null };
      if (mine !== generation.current) {
        teardown(session);
        return;
      }
      // Route to the chosen output through a hidden element; without setSinkId the context's own output is used.
      const canSink = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
      if (canSink) {
        const element = new Audio();
        element.srcObject = dest.stream;
        try {
          if (outputDevice !== "default") await (element as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(outputDevice);
        } catch {
          // an unplugged output falls back to the default device
        }
        outGain.connect(dest);
        await element.play().catch(() => undefined);
        session.element = element;
      } else {
        outGain.connect(ctx.destination);
      }
      if (mine !== generation.current) {
        teardown(session);
        return;
      }
      sessionRef.current = session;
      setTesting(true);
    } catch (e) {
      stream?.getTracks().forEach(t => t.stop());
      void ctx?.close().catch(() => undefined);
      const name = (e as { name?: string } | null)?.name;
      setError(name === "NotAllowedError" || name === "SecurityError" ? "Microphone access was not granted." : "Could not start the microphone test.");
    }
    // `resolved` is derived from the values listed in configKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey, inputVolume, outputVolume]);

  const toggle = useCallback(() => {
    if (sessionRef.current) stop();
    else void start();
  }, [start, stop]);

  // Poll the level the chain reports every 10 ms at a calmer rate for React.
  useEffect(() => {
    if (!testing) return;
    const timer = setInterval(() => setLevelDb(latest.current), 50);
    return () => clearInterval(timer);
  }, [testing]);

  useEffect(() => {
    sessionRef.current?.chain.setGain(inputVolume / 100);
  }, [inputVolume]);

  useEffect(() => {
    const session = sessionRef.current;
    if (session) session.outGain.gain.value = outputVolume / 100;
  }, [outputVolume]);

  // A different device or processing choice restarts a running test so it reflects what a call would do.
  const lastKey = useRef(configKey);
  useEffect(() => {
    if (lastKey.current === configKey) return;
    lastKey.current = configKey;
    if (sessionRef.current) {
      stop();
      void start();
    }
  }, [configKey, start, stop]);

  // Never leave the microphone open after the page unmounts.
  useEffect(() => stop, [stop]);

  return { testing, levelDb, error, toggle, stop };
}
