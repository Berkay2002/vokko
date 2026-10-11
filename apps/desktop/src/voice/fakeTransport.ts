// Mock-mode transport (endpoint "mock://voice"): no getUserMedia, no WebRTC. Connecting walks through the same statuses as
// LiveKit, the other participants "speak" on a fixed rhythm and the push-to-talk key drives the self speaking ring.
// The fake microphone follows the LiveKit transport's publish rules (nothing published while self-muted, device switches keep
// the mute) so engine tests can observe them.

import type { Snowflake } from "../api/types";
import { VadGate } from "./vad";
import type { TransportCallbacks, TransportOptions, VoiceTransport } from "./transport";
import type { VoiceSettings } from "./reducer";

/** Speaking toggles every this many ms (on, off, on, …). */
export const FAKE_SPEAK_PERIOD_MS = 1500;
const STEP_MS = 60;

export interface FakeMic {
  deviceId: string;
  muted: boolean;
}

export class FakeTransport implements VoiceTransport {
  /** The published microphone, or null when nothing is published. */
  mic: FakeMic | null = null;
  /** Every publish / device switch with the mic state at that moment. */
  readonly micLog: ({ event: "publish" | "switch" } & FakeMic)[] = [];
  private connected = false;
  private selfMute = false;
  private settings: VoiceSettings | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private ticker: ReturnType<typeof setInterval> | null = null;
  private options: TransportOptions | null = null;
  private on = false;
  private deaf = false;
  private gate: VadGate | null = null;
  private gateTicker: ReturnType<typeof setInterval> | null = null;
  private selfOpen = false;
  private volumes = new Map<Snowflake, number>();

  constructor(private readonly cb: TransportCallbacks) {}

  async connect(_endpoint: string, _token: string, options: TransportOptions): Promise<void> {
    await this.disconnect();
    this.options = options;
    this.deaf = options.selfDeaf;
    this.selfMute = options.selfMute;
    this.settings = options.settings;
    this.gate = new VadGate({ mode: options.settings.inputMode, thresholdDb: options.settings.vadThresholdDb, auto: options.settings.vadAuto, pttReleaseMs: options.settings.pttReleaseMs });
    this.gate.setForcedClosed(options.selfMute);
    this.timers.push(setTimeout(() => this.cb.status("rtc_connecting"), STEP_MS));
    this.timers.push(
      setTimeout(() => {
        this.connected = true;
        this.cb.status("connected");
        this.cb.quality("excellent", 12);
        if (!this.selfMute) this.publishMic();
        this.speakTick();
        this.ticker = setInterval(() => this.speakTick(), FAKE_SPEAK_PERIOD_MS);
      }, STEP_MS * 2),
    );
    // No microphone: the gate sees silence, so only push-to-talk opens it.
    this.gateTicker = setInterval(() => this.report(this.gate?.push(-100) ?? false), 10);
    void this.refreshDevices();
  }

  async disconnect(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.ticker) clearInterval(this.ticker);
    if (this.gateTicker) clearInterval(this.gateTicker);
    this.ticker = this.gateTicker = null;
    this.options = null;
    this.on = false;
    this.selfOpen = false;
    this.connected = false;
    this.mic = null;
  }

  async dispose(): Promise<void> {
    await this.disconnect();
  }

  setSelfMute(mute: boolean): void {
    this.selfMute = mute;
    this.gate?.setForcedClosed(mute);
    this.report(this.gate?.open ?? false);
    if (this.mic) this.mic.muted = mute;
    else if (!mute && this.connected) this.publishMic();
  }

  setSelfDeaf(deaf: boolean): void {
    this.deaf = deaf;
  }

  setUserVolume(userId: Snowflake, volume: number): void {
    this.volumes.set(userId, volume);
  }

  applySettings(settings: VoiceSettings): void {
    const prev = this.settings;
    this.settings = settings;
    if (this.mic && prev && prev.inputDeviceId !== settings.inputDeviceId) {
      this.mic = { deviceId: settings.inputDeviceId, muted: this.selfMute };
      this.micLog.push({ event: "switch", ...this.mic });
    }
    this.gate?.configure({ mode: settings.inputMode, thresholdDb: settings.vadThresholdDb, auto: settings.vadAuto, pttReleaseMs: settings.pttReleaseMs });
  }

  setPttPressed(pressed: boolean): void {
    this.report(this.gate?.setKey(pressed) ?? false);
  }

  async refreshDevices(): Promise<void> {
    this.cb.devices([{ deviceId: "default", label: "Default" }, { deviceId: "fake-mic", label: "Fake Microphone" }], [{ deviceId: "default", label: "Default" }], true);
  }

  /** Volume the fake mixer would play a user at (tests / debugging). */
  volumeOf(userId: Snowflake): number {
    return this.volumes.get(userId) ?? this.options?.volumeOf(userId) ?? 1;
  }

  get deafened(): boolean {
    return this.deaf;
  }

  private publishMic(): void {
    this.mic = { deviceId: this.settings?.inputDeviceId ?? "default", muted: this.selfMute };
    this.micLog.push({ event: "publish", ...this.mic });
  }

  private speakTick(): void {
    if (!this.options) return;
    this.on = !this.on;
    // Speaking is what the SFU reports; a locally muted or deafened listener still sees rings (as with LiveKit).
    this.cb.speaking(this.on ? this.options.participants() : []);
  }

  private report(open: boolean): void {
    if (open === this.selfOpen) return;
    this.selfOpen = open;
    this.cb.selfSpeaking(open);
  }
}
