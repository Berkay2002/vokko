import { describe, expect, it } from "vitest";
import { levelToSegments, splitDeviceLabel } from "./voiceVideoHelpers";

describe("splitDeviceLabel", () => {
  it("splits the trailing group and keeps nested parentheses", () => {
    expect(splitDeviceLabel("Microphone (Realtek(R) Audio)")).toEqual({ name: "Microphone", detail: "Realtek(R) Audio" });
    expect(splitDeviceLabel("Headset (USB Audio)")).toEqual({ name: "Headset", detail: "USB Audio" });
  });
  it("leaves labels without a trailing group alone", () => {
    expect(splitDeviceLabel("Default")).toEqual({ name: "Default", detail: "" });
    expect(splitDeviceLabel("Speakers (left) rear")).toEqual({ name: "Speakers (left) rear", detail: "" });
  });
  it("keeps a label that is only a group, and unbalanced input", () => {
    expect(splitDeviceLabel("(Built-in)")).toEqual({ name: "(Built-in)", detail: "" });
    expect(splitDeviceLabel("Mic x)")).toEqual({ name: "Mic x)", detail: "" });
  });
});

describe("levelToSegments", () => {
  it("maps dBFS to lit segments", () => {
    expect(levelToSegments(-100, 40)).toBe(0);
    expect(levelToSegments(0, 40)).toBe(40);
    expect(levelToSegments(-50, 40)).toBe(20);
  });
  it("clamps and ignores bad values", () => {
    expect(levelToSegments(-200, 40)).toBe(0);
    expect(levelToSegments(12, 40)).toBe(40);
    expect(levelToSegments(Number.NaN, 40)).toBe(0);
    expect(levelToSegments(-10, 0)).toBe(0);
  });
});
