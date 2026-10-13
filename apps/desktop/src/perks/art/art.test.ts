import { describe, expect, it } from "vitest";
import { AVATAR_DECORATIONS, NAMEPLATES, PROFILE_EFFECTS, PROFILE_FRAMES } from "../catalog";
import { DECORATION_ART } from "./decorations";
import { EFFECT_SHAPES } from "./effects";
import { FRAME_ART } from "./frames";
import { NAMEPLATE_ART } from "./nameplates";
import { SCENES } from "./scenes";

const ID_RE = /^[a-z0-9_-]{1,64}$/;

describe("illustrated perks", () => {
  it("draws every illustrated catalog item and nothing else", () => {
    const decos = AVATAR_DECORATIONS.filter(d => d.art).map(d => d.id);
    expect(decos.sort()).toEqual(Object.keys(DECORATION_ART).sort());
    const plates = NAMEPLATES.filter(n => n.art).map(n => n.id);
    expect(plates.sort()).toEqual(Object.keys(NAMEPLATE_ART).sort());
    const scenes = PROFILE_EFFECTS.filter(e => e.scene).map(e => e.id);
    expect(scenes.sort()).toEqual(Object.keys(SCENES).sort());
    for (const effect of PROFILE_EFFECTS) if (!effect.scene && effect.section) expect(EFFECT_SHAPES[effect.shape]).toBeDefined();
    expect(PROFILE_FRAMES.map(f => f.id).sort()).toEqual(Object.keys(FRAME_ART).sort());
  });

  it("lists the scene effects before the particle effects", () => {
    const firstParticle = PROFILE_EFFECTS.findIndex(e => !e.scene);
    expect(PROFILE_EFFECTS.slice(firstParticle).every(e => !e.scene)).toBe(true);
  });

  it("uses unique ids the server accepts, with a section for every illustrated item", () => {
    for (const set of [AVATAR_DECORATIONS, NAMEPLATES, PROFILE_EFFECTS, PROFILE_FRAMES]) {
      const ids = set.map(item => item.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(ID_RE);
    }
    for (const item of [...AVATAR_DECORATIONS, ...NAMEPLATES]) if (item.art) expect(item.section).toBeTruthy();
    for (const item of [...PROFILE_FRAMES, ...PROFILE_EFFECTS.filter(e => e.scene)]) expect(item.section).toBeTruthy();
  });
});
