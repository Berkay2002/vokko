import { describe, expect, it } from "vitest";
import { stremioKey } from "./keys";

const ctx = { controller: true, fullscreen: true, blocked: false };
const body = { tagName: "DIV" };

describe("full-screen keys", () => {
  it("maps Space, Left and Right for the controller in full screen", () => {
    expect(stremioKey({ key: " ", target: body }, ctx)).toBe("toggle");
    expect(stremioKey({ key: "ArrowLeft", target: body }, ctx)).toBe("back");
    expect(stremioKey({ key: "ArrowRight", target: body }, ctx)).toBe("forward");
    expect(stremioKey({ key: "a", target: body }, ctx)).toBeNull();
  });

  it("does nothing for someone who does not control, outside full screen, or with a menu open", () => {
    expect(stremioKey({ key: " ", target: body }, { ...ctx, controller: false })).toBeNull();
    expect(stremioKey({ key: " ", target: body }, { ...ctx, fullscreen: false })).toBeNull();
    expect(stremioKey({ key: "ArrowLeft", target: body }, { ...ctx, blocked: true })).toBeNull();
  });

  it("never takes keys meant for typing, sliders or modified shortcuts", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) expect(stremioKey({ key: "ArrowRight", target: { tagName } }, ctx)).toBeNull();
    expect(stremioKey({ key: " ", target: { tagName: "DIV", isContentEditable: true } }, ctx)).toBeNull();
    expect(stremioKey({ key: "ArrowLeft", target: body, ctrlKey: true }, ctx)).toBeNull();
    expect(stremioKey({ key: " ", target: body, defaultPrevented: true }, ctx)).toBeNull();
  });

  it("leaves Space to a focused button and ignores a held Space, but still seeks from a button", () => {
    expect(stremioKey({ key: " ", target: { tagName: "BUTTON" } }, ctx)).toBeNull();
    expect(stremioKey({ key: "ArrowRight", target: { tagName: "BUTTON" } }, ctx)).toBe("forward");
    expect(stremioKey({ key: " ", target: body, repeat: true }, ctx)).toBeNull();
  });
});
