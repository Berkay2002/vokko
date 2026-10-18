import { describe, expect, it } from "vitest";
import type { StremioState, WatchTogetherState } from "../api/types";
import { popoutKeyAction } from "./keys";
import { JUMP_MS, watchPatch, type PopoutSession } from "./protocol";
import { buildSession, cuePositionMs, jumpTarget, patchFor, popoutKind } from "./relay";

const stremio = { status: "playing", playing: true, position_ms: 60_000, updated_at_ms: 1_000_000, duration_ms: 600_000, item: { title: "T" } } as unknown as StremioState;
const watch = { video_id: "abc", playing: false, position_ms: 5_000, updated_at_ms: 1_000_000 } as unknown as WatchTogetherState;
const input = { channelId: "c1", controller: true, muted: false, volume: 50, output: 0.5, pick: null, skipLabel: "Skip" };

describe("popoutKeyAction (the full-screen rule of stremio/keys.ts)", () => {
  const key = (k: string, extra: object = {}) => popoutKeyAction({ key: k, target: { tagName: "DIV" }, ...extra }, true, false);
  it("maps Space and the arrows for the controller", () => {
    expect(key(" ")).toEqual({ type: "playing", on: true });
    expect(popoutKeyAction({ key: " ", target: null }, true, true)).toEqual({ type: "playing", on: false });
    expect(key("ArrowLeft")).toEqual({ type: "jump", deltaMs: -JUMP_MS });
    expect(key("ArrowRight")).toEqual({ type: "jump", deltaMs: JUMP_MS });
  });
  it("gives nothing to a listener who cannot control", () => {
    expect(popoutKeyAction({ key: " ", target: null }, false, false)).toBeNull();
  });
  it("ignores repeats, modifiers, handled keys and other keys", () => {
    expect(key(" ", { repeat: true })).toBeNull();
    expect(key("ArrowRight", { repeat: true })).toBeNull();
    expect(key(" ", { ctrlKey: true })).toBeNull();
    expect(key("ArrowLeft", { shiftKey: true })).toBeNull();
    expect(key(" ", { defaultPrevented: true })).toBeNull();
    expect(key("a")).toBeNull();
  });
  it("leaves typing, sliders and a focused button's own Space alone", () => {
    expect(popoutKeyAction({ key: " ", target: { tagName: "INPUT", type: "text" } }, true, false)).toBeNull();
    expect(popoutKeyAction({ key: " ", target: { tagName: "TEXTAREA" } }, true, false)).toBeNull();
    expect(popoutKeyAction({ key: " ", target: { tagName: "DIV", isContentEditable: true } }, true, false)).toBeNull();
    expect(popoutKeyAction({ key: "ArrowRight", target: { tagName: "INPUT", type: "range" } }, true, false)).toBeNull();
    expect(popoutKeyAction({ key: " ", target: { tagName: "BUTTON" } }, true, false)).toBeNull();
  });
});

describe("buildSession", () => {
  it("picks the session of the kind and drops it with the session", () => {
    expect(buildSession("stremio", { ...input, stremio })?.kind).toBe("stremio");
    expect(buildSession("watch", { ...input, watch })).toMatchObject({ kind: "watch", skipLabel: "Skip" });
    expect(buildSession("stremio", { ...input, watch })).toBeNull();
    expect(buildSession("watch", { ...input, stremio })).toBeNull();
  });
  it("popoutKind prefers the movie", () => {
    expect(popoutKind({ stremio, watch })).toBe("stremio");
    expect(popoutKind({ watch })).toBe("watch");
    expect(popoutKind({})).toBeNull();
  });
});

describe("patchFor", () => {
  const s = (controller: boolean): PopoutSession => ({ kind: "stremio", channelId: "c1", controller, muted: false, state: stremio, volume: 50, output: 0.5, pick: null });
  it("turns playback actions into PATCHes for the controller only", () => {
    expect(patchFor({ type: "playing", on: false }, s(true), 0)).toEqual({ playing: false });
    expect(patchFor({ type: "seek", ms: 12_345.6 }, s(true), 0)).toEqual({ position_ms: 12_346 });
    expect(patchFor({ type: "playing", on: false }, s(false), 0)).toBeNull();
    expect(patchFor({ type: "jump", deltaMs: JUMP_MS }, s(false), 0)).toBeNull();
  });
  it("jumps from where the film is now and stays inside it", () => {
    expect(patchFor({ type: "jump", deltaMs: JUMP_MS }, s(true), 1_005_000)).toEqual({ position_ms: 75_000 });
    expect(patchFor({ type: "jump", deltaMs: -JUMP_MS }, s(true), 1_000_000)).toEqual({ position_ms: 50_000 });
  });
  it("refuses numbers that are not numbers and actions that are not playback", () => {
    expect(patchFor({ type: "seek", ms: Number.NaN }, s(true), 0)).toBeNull();
    expect(patchFor({ type: "jump", deltaMs: Number.POSITIVE_INFINITY }, s(true), 0)).toBeNull();
    expect(patchFor({ type: "mute" }, s(true), 0)).toBeNull();
  });
  it("a Watch Together jump has no upper bound", () => {
    const w: PopoutSession = { kind: "watch", channelId: "c1", controller: true, muted: false, state: watch, skipLabel: "Skip" };
    expect(patchFor({ type: "jump", deltaMs: JUMP_MS }, w, 1_000_000)).toEqual({ position_ms: 15_000 });
  });
});

describe("jumpTarget and cuePositionMs", () => {
  it("clamps to the film", () => {
    expect(jumpTarget(5_000, -JUMP_MS)).toBe(0);
    expect(jumpTarget(595_000, JUMP_MS, 600_000)).toBe(600_000);
    expect(jumpTarget(595_000, JUMP_MS)).toBe(605_000);
  });
  it("cues wait for the picture only while it plays", () => {
    expect(cuePositionMs(stremio, 1_000_000, 2_000)).toBe(58_000);
    expect(cuePositionMs({ ...stremio, playing: false }, 1_000_000, 2_000)).toBe(60_000);
    expect(cuePositionMs({ ...stremio, position_ms: 500 }, 1_000_000, 2_000)).toBe(0);
  });
});

describe("watchPatch", () => {
  it("lets through the player's own PATCHes only", () => {
    expect(watchPatch({ skip: true, video_id: "abc" })).toEqual({ skip: true, video_id: "abc" });
    expect(watchPatch({ title: "x".repeat(900) })).toEqual({ title: "x".repeat(500) });
  });
  it("refuses everything else", () => {
    expect(watchPatch({ position_ms: 5 })).toBeNull();
    expect(watchPatch({ skip: true, playing: true })).toBeNull();
    expect(watchPatch({ skip: "yes" })).toBeNull();
    expect(watchPatch({})).toBeNull();
    expect(watchPatch(null)).toBeNull();
    expect(watchPatch("skip")).toBeNull();
  });
});
