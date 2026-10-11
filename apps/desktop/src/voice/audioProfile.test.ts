import { describe, expect, it } from "vitest";
import { fromSuppressionChoice, isInputProfile, resolveAudio, suppressionChoice, type AudioPrefs } from "./audioProfile";

const base: AudioPrefs = {
  inputProfile: "custom",
  noiseSuppression: false,
  noiseSuppressionKind: "standard",
  echoCancellation: false,
  autoGainControl: false,
  bypassSystemProcessing: false,
};

describe("resolveAudio", () => {
  it("isolation turns everything on and ignores the custom toggles", () => {
    expect(resolveAudio({ ...base, inputProfile: "isolation" })).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      rnnoise: false,
    });
  });

  it("studio turns everything off and ignores the custom toggles", () => {
    expect(
      resolveAudio({ ...base, inputProfile: "studio", noiseSuppression: true, echoCancellation: true, autoGainControl: true, noiseSuppressionKind: "rnnoise" }),
    ).toEqual({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, rnnoise: false });
  });

  it("custom uses the individual controls", () => {
    expect(resolveAudio({ ...base, noiseSuppression: true, echoCancellation: true })).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
      rnnoise: false,
    });
    expect(resolveAudio({ ...base, autoGainControl: true })).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
      rnnoise: false,
    });
  });

  it("rnnoise replaces browser noise suppression, never stacks with it", () => {
    const r = resolveAudio({ ...base, noiseSuppression: true, noiseSuppressionKind: "rnnoise", echoCancellation: true });
    expect(r.rnnoise).toBe(true);
    expect(r.noiseSuppression).toBe(false);
    expect(r.echoCancellation).toBe(true);
    const iso = resolveAudio({ ...base, inputProfile: "isolation", noiseSuppressionKind: "rnnoise" });
    expect(iso).toEqual({ echoCancellation: true, noiseSuppression: false, autoGainControl: true, rnnoise: true });
  });

  it("rnnoise kind with suppression off does not run rnnoise", () => {
    expect(resolveAudio({ ...base, noiseSuppression: false, noiseSuppressionKind: "rnnoise" }).rnnoise).toBe(false);
  });

  it("bypass requests raw capture but keeps rnnoise when selected", () => {
    expect(resolveAudio({ ...base, inputProfile: "isolation", bypassSystemProcessing: true })).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      rnnoise: false,
    });
    expect(resolveAudio({ ...base, inputProfile: "isolation", noiseSuppressionKind: "rnnoise", bypassSystemProcessing: true })).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      rnnoise: true,
    });
  });
});

describe("suppressionChoice", () => {
  it("is none when off, otherwise the kind", () => {
    expect(suppressionChoice(false, "standard")).toBe("none");
    expect(suppressionChoice(false, "rnnoise")).toBe("none");
    expect(suppressionChoice(true, "standard")).toBe("standard");
    expect(suppressionChoice(true, "rnnoise")).toBe("rnnoise");
  });
});

describe("fromSuppressionChoice", () => {
  it("none keeps the current kind and switches off", () => {
    expect(fromSuppressionChoice("none", "rnnoise")).toEqual({ noiseSuppression: false, noiseSuppressionKind: "rnnoise" });
  });
  it("a kind switches on and sets the kind", () => {
    expect(fromSuppressionChoice("standard", "rnnoise")).toEqual({ noiseSuppression: true, noiseSuppressionKind: "standard" });
    expect(fromSuppressionChoice("rnnoise", "standard")).toEqual({ noiseSuppression: true, noiseSuppressionKind: "rnnoise" });
  });
  it("round-trips with suppressionChoice", () => {
    for (const choice of ["none", "standard", "rnnoise"] as const) {
      const p = fromSuppressionChoice(choice, "standard");
      expect(suppressionChoice(p.noiseSuppression, p.noiseSuppressionKind)).toBe(choice);
    }
  });
});

describe("isInputProfile", () => {
  it("accepts the three profiles only", () => {
    expect(isInputProfile("isolation")).toBe(true);
    expect(isInputProfile("studio")).toBe(true);
    expect(isInputProfile("custom")).toBe(true);
    expect(isInputProfile("other")).toBe(false);
    expect(isInputProfile(undefined)).toBe(false);
  });
});
