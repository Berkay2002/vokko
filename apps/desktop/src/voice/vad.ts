// Voice activity / push-to-talk gate (docs/design/voice.md §3.3). Pure and frame-based: the audio adapter (./gate.ts)
// pushes one RMS level in dBFS per 10 ms frame; time only advances through `push`, so tests drive it with arrays.

import type { InputMode } from "./reducer";

export const FRAME_MS = 10;
export const HANGOVER_MS = 400;
export const DEFAULT_PTT_RELEASE_MS = 20;
/** Adaptive threshold sits this far above the tracked noise floor. */
export const AUTO_MARGIN_DB = 15;
/** Floor of the dBFS scale (digital silence). */
export const SILENCE_DB = -100;

export interface VadGateOptions {
  mode: InputMode;
  /** Manual threshold in dBFS; ignored while `auto` is on. */
  thresholdDb: number;
  auto: boolean;
  hangoverMs?: number;
  pttReleaseMs?: number;
  frameMs?: number;
}

export class VadGate {
  private mode: InputMode;
  private thresholdDb: number;
  private auto: boolean;
  private readonly hangoverMs: number;
  private pttReleaseMs: number;
  private readonly frameMs: number;
  private isOpen = false;
  /** ms of gate time left after the last frame above the threshold (VAD) or after key release (PTT). */
  private remainingMs = 0;
  private keyHeld = false;
  /** Tracked noise floor in dBFS (auto threshold). */
  private floorDb = -70;
  private forcedClosed = false;

  constructor(options: VadGateOptions) {
    this.mode = options.mode;
    this.thresholdDb = options.thresholdDb;
    this.auto = options.auto;
    this.hangoverMs = options.hangoverMs ?? HANGOVER_MS;
    this.pttReleaseMs = options.pttReleaseMs ?? DEFAULT_PTT_RELEASE_MS;
    this.frameMs = options.frameMs ?? FRAME_MS;
  }

  get open(): boolean {
    return this.isOpen;
  }

  /** Threshold currently in effect (manual, or noise floor + margin). */
  get effectiveThresholdDb(): number {
    return this.auto ? Math.min(0, this.floorDb + AUTO_MARGIN_DB) : this.thresholdDb;
  }

  configure(options: Partial<Pick<VadGateOptions, "mode" | "thresholdDb" | "auto" | "pttReleaseMs">>): void {
    if (options.mode !== undefined && options.mode !== this.mode) {
      this.mode = options.mode;
      this.isOpen = false;
      this.remainingMs = 0;
    }
    if (options.thresholdDb !== undefined) this.thresholdDb = options.thresholdDb;
    if (options.auto !== undefined) this.auto = options.auto;
    if (options.pttReleaseMs !== undefined) this.pttReleaseMs = options.pttReleaseMs;
  }

  /** Self mute: the gate stays closed whatever the level or key. */
  setForcedClosed(closed: boolean): void {
    this.forcedClosed = closed;
    if (closed) {
      this.isOpen = false;
      this.remainingMs = 0;
    }
  }

  /** Push-to-talk key state. Opens immediately on press; closes `pttReleaseMs` after release (counted in frames). */
  setKey(pressed: boolean): boolean {
    if (pressed === this.keyHeld) return this.isOpen;
    this.keyHeld = pressed;
    if (this.mode !== "ptt" || this.forcedClosed) return this.isOpen;
    if (pressed) {
      this.isOpen = true;
      this.remainingMs = 0;
    } else {
      this.remainingMs = this.pttReleaseMs;
      if (this.remainingMs <= 0) this.isOpen = false;
    }
    return this.isOpen;
  }

  /** One frame of input level (dBFS). Returns whether the gate is open after this frame. */
  push(levelDb: number): boolean {
    const level = Number.isFinite(levelDb) ? Math.max(SILENCE_DB, levelDb) : SILENCE_DB;
    this.trackFloor(level);
    if (this.forcedClosed) return (this.isOpen = false);
    if (this.mode === "ptt") {
      if (!this.keyHeld && this.isOpen) {
        this.remainingMs -= this.frameMs;
        if (this.remainingMs <= 0) this.isOpen = false;
      }
      return this.isOpen;
    }
    if (level >= this.effectiveThresholdDb) {
      this.isOpen = true;
      this.remainingMs = this.hangoverMs;
    } else if (this.isOpen) {
      this.remainingMs -= this.frameMs;
      if (this.remainingMs <= 0) this.isOpen = false;
    }
    return this.isOpen;
  }

  /** Noise floor: follows quiet frames quickly, rises slowly (speech must not drag it up). */
  private trackFloor(level: number): void {
    if (level < this.floorDb) this.floorDb += (level - this.floorDb) * 0.2;
    else this.floorDb += (level - this.floorDb) * 0.002;
  }
}

/** RMS of a block of float samples in dBFS (-100 for silence). */
export function rmsDb(samples: ArrayLike<number>): number {
  if (samples.length === 0) return SILENCE_DB;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB;
}

/** Settings slider (0..100 %, Discord-style) → threshold in dBFS (-100..0). */
export const sensitivityToDb = (percent: number): number => Math.max(SILENCE_DB, Math.min(0, percent - 100));
