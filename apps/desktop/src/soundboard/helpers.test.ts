import { describe, expect, it } from "vitest";
import type { SoundboardSound } from "../api/types";
import { buildSections, clampTrim, effectiveVolume, encodeWav, initialTrim, isAcceptedAudio, needsReencode, percentToVolume, soundKey, validateSoundName, volumeToPercent, wavDurationMs } from "./helpers";
import { DEFAULT_SOUNDS, synthWav } from "./synth";

const sound = (id: string, name: string, guildId?: string, emoji: string | null = null): SoundboardSound => ({
  sound_id: id,
  name,
  volume: 1,
  emoji_id: null,
  emoji_name: emoji,
  ...(guildId ? { guild_id: guildId } : {}),
  available: true,
  url: `blob:${id}`,
});

describe("volume", () => {
  it("multiplies the sound's volume by the soundboard volume setting, clamped", () => {
    expect(effectiveVolume(0.5, 100)).toBe(0.5);
    expect(effectiveVolume(0.5, 50)).toBe(0.25);
    expect(effectiveVolume(1, 0)).toBe(0);
    expect(effectiveVolume(2, 150)).toBe(1);
    expect(effectiveVolume(-1, 80)).toBe(0);
    expect(effectiveVolume(Number.NaN, 80)).toBe(0);
  });

  it("converts between the slider and the API's 0..1", () => {
    expect(percentToVolume(37)).toBe(0.37);
    expect(percentToVolume(140)).toBe(1);
    expect(volumeToPercent(0.256)).toBe(26);
    expect(volumeToPercent(3)).toBe(100);
  });
});

describe("trimming", () => {
  it("starts with the first 5.2 s, or the whole clip", () => {
    expect(initialTrim(12)).toEqual({ start: 0, end: 5.2 });
    expect(initialTrim(3.25)).toEqual({ start: 0, end: 3.25 });
  });

  it("keeps the window inside the clip and at most 5.2 s, moving the handle that was not dragged", () => {
    expect(clampTrim({ start: 1, end: 9 }, 10, "end")).toEqual({ start: 3.8, end: 9 });
    expect(clampTrim({ start: 1, end: 9 }, 10, "start")).toEqual({ start: 1, end: 6.2 });
    expect(clampTrim({ start: -2, end: 20 }, 4, "end")).toEqual({ start: 0, end: 4 });
    expect(clampTrim({ start: 3, end: 2 }, 10, "start")).toEqual({ start: 3, end: 3 });
    expect(clampTrim({ start: 3, end: 2 }, 10, "end")).toEqual({ start: 2, end: 2 });
  });

  it("re-encodes only when the file cannot go up as is", () => {
    const wav = { type: "audio/wav", name: "a.wav", size: 100_000 };
    expect(needsReencode(wav, 3, { start: 0, end: 3 })).toBe(false);
    expect(needsReencode(wav, 3, { start: 0.5, end: 3 })).toBe(true);
    expect(needsReencode(wav, 6, { start: 0, end: 5.2 })).toBe(true);
    expect(needsReencode({ ...wav, size: 600 * 1024 }, 3, { start: 0, end: 3 })).toBe(true);
    expect(needsReencode({ type: "audio/flac", name: "a.flac", size: 10 }, 1, { start: 0, end: 1 })).toBe(true);
  });
});

describe("WAV", () => {
  it("encodes the trimmed window as mono 16-bit and measures it back exactly", () => {
    const rate = 48000;
    const left = new Float32Array(rate * 8).fill(0.5);
    const right = new Float32Array(rate * 8).fill(-0.25);
    const bytes = encodeWav([left, right], rate, 1, 6.2);
    expect(wavDurationMs(bytes)).toBe(5200);
    expect(bytes.length).toBe(44 + 5.2 * 22050 * 2);
    expect(bytes.length).toBeLessThan(512 * 1024);
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(22050);
    expect(view.getInt16(44, true)).toBe(Math.round(0.125 * 32767)); // average of both channels
  });

  it("never upsamples, and rejects what is not WAV", () => {
    const bytes = encodeWav([new Float32Array(8000)], 8000, 0, 1);
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(8000);
    expect(wavDurationMs(bytes)).toBe(1000);
    expect(wavDurationMs(new TextEncoder().encode("ID3 not a wave file"))).toBeNull();
    expect(wavDurationMs(new Uint8Array(4))).toBeNull();
    // A lying byte-rate field would hide the real length from the check.
    const lying = encodeWav([new Float32Array(8000 * 30)], 8000, 0, 30);
    new DataView(lying.buffer).setUint32(28, 0xffffffff, true);
    expect(wavDurationMs(lying)).toBeNull();
    // Extensible format with a huge block align, and a second fmt or data chunk, are refused too.
    const one = encodeWav([new Float32Array(8000)], 8000, 0, 1);
    const extensible = one.slice();
    const ext = new DataView(extensible.buffer);
    ext.setUint16(20, 0xfffe, true);
    ext.setUint32(28, 8000 * 65535, true);
    ext.setUint16(32, 65535, true);
    expect(wavDurationMs(extensible)).toBeNull();
    // Extensible needs cbSize >= 22 and a PCM or IEEE float SubFormat GUID.
    const tail = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    const extended = (cbSize: number, subFormat: number, guid = tail) => {
      const fmt = new Uint8Array(48);
      const f = new DataView(fmt.buffer);
      fmt.set(new TextEncoder().encode("fmt "));
      f.setUint32(4, 40, true);
      fmt.set(one.subarray(20, 36), 8);
      f.setUint16(8, 0xfffe, true);
      f.setUint16(24, cbSize, true);
      f.setUint16(26, 16, true);
      f.setUint16(32, subFormat, true);
      fmt.set(guid, 34);
      return new Uint8Array([...one.subarray(0, 12), ...fmt, ...one.subarray(36)]);
    };
    expect(wavDurationMs(extended(22, 1))).toBe(1000);
    expect(wavDurationMs(extended(22, 3))).toBe(1000);
    expect(wavDurationMs(extended(0, 1))).toBeNull();
    expect(wavDurationMs(extended(22, 2))).toBeNull();
    expect(wavDurationMs(extended(22, 1, [...tail.slice(0, 13), 0]))).toBeNull();
    const notPcm = one.slice();
    new DataView(notPcm.buffer).setUint16(20, 2, true);
    expect(wavDurationMs(notPcm)).toBeNull();
    const twoFmt = new Uint8Array([...one.subarray(0, 36), ...one.subarray(12, 36), ...one.subarray(36)]);
    expect(wavDurationMs(twoFmt)).toBeNull();
    const extra = new Uint8Array(8 + 16000);
    extra.set(new TextEncoder().encode("data"));
    new DataView(extra.buffer).setUint32(4, 16000, true);
    expect(wavDurationMs(new Uint8Array([...one, ...extra]))).toBeNull();
  });

  it("the synthesized default sounds are short valid WAVs", () => {
    for (const meta of DEFAULT_SOUNDS) {
      const bytes = synthWav(meta.id);
      expect(bytes, meta.name).not.toBeNull();
      const ms = wavDurationMs(bytes!);
      expect(ms).toBeGreaterThanOrEqual(100);
      expect(ms).toBeLessThanOrEqual(1500);
    }
    expect(synthWav("99")).toBeNull();
  });
});

describe("files and names", () => {
  it("accepts MP3, OGG and WAV by type, or by extension when there is no type", () => {
    expect(isAcceptedAudio({ type: "audio/mpeg", name: "x" })).toBe(true);
    expect(isAcceptedAudio({ type: "audio/x-wav", name: "x" })).toBe(true);
    expect(isAcceptedAudio({ type: "", name: "clip.OGG" })).toBe(true);
    expect(isAcceptedAudio({ type: "video/mp4", name: "clip.mp3" })).toBe(false);
    expect(isAcceptedAudio({ type: "", name: "clip.flac" })).toBe(false);
  });

  it("names are 2-32 characters", () => {
    expect(validateSoundName(" a ")).not.toBeNull();
    expect(validateSoundName("ok")).toBeNull();
    expect(validateSoundName("x".repeat(33))).not.toBeNull();
  });
});

describe("popout sections", () => {
  const input = {
    query: "",
    favorites: [] as string[],
    currentGuildId: "g2",
    guildOrder: ["g1", "g2", "g3"],
    guildNames: { g1: "One", g2: "Two", g3: "Three" },
    guildSounds: { g1: [sound("10", "Horn", "g1", "📯")], g2: [sound("20", "Bell", "g2")], g3: [] },
    defaults: [sound("1", "Chime"), sound("2", "Pop")],
  };

  it("current server first, then the other servers, then the defaults; empty sections are dropped", () => {
    expect(buildSections(input).map(s => s.title)).toEqual(["Two", "One", "Default Sounds"]);
  });

  it("favourites come first and resolve across servers and defaults", () => {
    const sections = buildSections({ ...input, favorites: ["default:2", "g1:10", "g9:404"] });
    expect(sections[0]?.title).toBe("Favorites");
    expect(sections[0]?.sounds.map(soundKey)).toEqual(["default:2", "g1:10"]);
  });

  it("search filters every section by name or emoji", () => {
    expect(buildSections({ ...input, query: "HOR" }).flatMap(s => s.sounds.map(x => x.name))).toEqual(["Horn"]);
    expect(buildSections({ ...input, query: "📯" }).flatMap(s => s.sounds.map(x => x.name))).toEqual(["Horn"]);
    expect(buildSections({ ...input, query: "nothing" })).toEqual([]);
  });
});
