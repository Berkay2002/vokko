import { describe, expect, it } from "vitest";
import { VOICE_SOUNDS, isSoundEnabled, isVoiceSoundId, parseDisabledSounds, serializeDisabledSounds, withSoundEnabled } from "./soundCatalog";

describe("VOICE_SOUNDS", () => {
  it("has unique ids and labels", () => {
    const ids = VOICE_SOUNDS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const labels = VOICE_SOUNDS.map(s => s.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
  it("puts four rows in the primary group", () => {
    expect(VOICE_SOUNDS.filter(s => s.group === "primary").map(s => s.id)).toEqual(["mute", "unmute", "deafen", "undeafen"]);
  });
  it("isVoiceSoundId recognises catalog ids only", () => {
    expect(isVoiceSoundId("mute")).toBe(true);
    expect(isVoiceSoundId("nope")).toBe(false);
    expect(isVoiceSoundId("")).toBe(false);
  });
});

describe("parseDisabledSounds", () => {
  it("parses a comma separated list", () => {
    expect([...parseDisabledSounds("mute,deafen")].sort()).toEqual(["deafen", "mute"]);
  });
  it("drops unknown ids, empties and trims whitespace", () => {
    expect([...parseDisabledSounds(" mute , bogus,, user-join ")].sort()).toEqual(["mute", "user-join"]);
  });
  it("empty string is an empty set", () => {
    expect(parseDisabledSounds("").size).toBe(0);
  });
});

describe("serializeDisabledSounds", () => {
  it("writes in catalog order regardless of input order", () => {
    expect(serializeDisabledSounds(["user-join", "mute", "deafen"])).toBe("mute,deafen,user-join");
  });
  it("is stable and de-duplicates", () => {
    const once = serializeDisabledSounds(["mute", "mute", "camera-on"]);
    expect(once).toBe("mute,camera-on");
    expect(serializeDisabledSounds(parseDisabledSounds(once))).toBe(once);
  });
  it("empty gives an empty string", () => {
    expect(serializeDisabledSounds([])).toBe("");
  });
});

describe("isSoundEnabled / withSoundEnabled", () => {
  it("everything is enabled by default", () => {
    expect(isSoundEnabled("", "mute")).toBe(true);
  });
  it("a listed id is disabled", () => {
    expect(isSoundEnabled("mute,deafen", "mute")).toBe(false);
    expect(isSoundEnabled("mute,deafen", "unmute")).toBe(true);
  });
  it("disables and re-enables an id", () => {
    const off = withSoundEnabled("", "user-join", false);
    expect(off).toBe("user-join");
    expect(withSoundEnabled(off, "mute", false)).toBe("mute,user-join");
    expect(withSoundEnabled("mute,user-join", "mute", true)).toBe("user-join");
    expect(withSoundEnabled("user-join", "user-join", true)).toBe("");
  });
  it("is idempotent and cleans unknown ids", () => {
    expect(withSoundEnabled("mute", "mute", false)).toBe("mute");
    expect(withSoundEnabled("bogus,mute", "deafen", false)).toBe("mute,deafen");
  });
});
