import { describe, expect, it } from "vitest";
import type { Channel, User, VoiceState } from "../api/types";
import { initialVoiceModel } from "../voice/reducer";
import { overlayActive, overlayState } from "./bridge";
import { frameFor } from "./Overlay";
import { DEFAULT_OVERLAY, sanitizeOverlay } from "./settings";

const user = (id: string, name: string): User => ({ id, username: name, global_name: null, avatar: null }) as unknown as User;
const vs = (user_id: string, extra: Partial<VoiceState> = {}): VoiceState => ({
  guild_id: "g1",
  channel_id: "v1",
  user_id,
  session_id: "s",
  deaf: false,
  mute: false,
  self_deaf: false,
  self_mute: false,
  self_video: false,
  self_stream: false,
  suppress: false,
  request_to_speak_timestamp: null,
  connected_at: `2026-10-18T10:00:0${user_id.length}Z`,
  ...extra,
});

const app = {
  channels: { v1: { id: "v1", name: "General", guild_id: "g1" } as Channel },
  guilds: { g1: { id: "g1", name: "Gamers" } } as never,
  users: { a: user("a", "ana"), bb: user("bb", "bo"), ccc: user("ccc", "cy") },
  members: {},
};

const voice = {
  ...initialVoiceModel,
  channelId: "v1",
  guildId: "g1",
  status: "connected" as const,
  states: { a: vs("a"), bb: vs("bb", { self_mute: true }), ccc: vs("ccc", { self_deaf: true, self_mute: true }), x: vs("x", { channel_id: "other" }) },
  speaking: { a: true as const, bb: true as const },
};

describe("overlay state", () => {
  it("lists the call in join order with speaking, mute and deafen", () => {
    const state = overlayState(voice, app, DEFAULT_OVERLAY, []);
    expect(state.call?.channel).toBe("General");
    expect(state.call?.guild).toBe("Gamers");
    expect(state.call?.members.map(m => [m.name, m.speaking, m.muted, m.deafened])).toEqual([
      ["ana", true, false, false],
      // A muted user's speaking flag never lights the ring.
      ["bo", false, true, false],
      ["cy", false, true, true],
    ]);
  });

  it("is not in a call while connecting or idle", () => {
    expect(overlayState({ ...voice, status: "connecting" }, app, DEFAULT_OVERLAY, []).call).toBeNull();
    expect(overlayState({ ...voice, channelId: null }, app, DEFAULT_OVERLAY, []).call).toBeNull();
  });

  it("shows only with something on it", () => {
    const toast = { id: "m1", title: "t", body: "b", icon: "", channelId: "c", guildId: null, messageId: "m1" };
    const idle = { ...voice, channelId: null };
    const on = { ...DEFAULT_OVERLAY, enabled: true };
    expect(overlayActive(overlayState(idle, app, on, []), on)).toBe(false);
    expect(overlayActive(overlayState(idle, app, on, [toast]), on)).toBe(true);
    expect(overlayActive(overlayState(idle, app, { ...on, onlyInCall: true }, [toast]), { ...on, onlyInCall: true })).toBe(false);
    expect(overlayActive(overlayState(voice, app, on, []), on)).toBe(true);
    expect(overlayActive(overlayState(voice, app, on, []), { ...on, enabled: false })).toBe(false);
    // Notifications off: toasts are dropped from the state.
    expect(overlayState(idle, app, { ...on, notifications: "off" }, [toast]).toasts).toEqual([]);
  });
});

describe("overlay settings", () => {
  it("keeps valid values and drops the rest", () => {
    expect(sanitizeOverlay(null)).toEqual(DEFAULT_OVERLAY);
    expect(sanitizeOverlay({ corner: "middle", opacity: 5, notifications: "off", hotkey: "Ctrl+F9", enabled: false })).toEqual({
      ...DEFAULT_OVERLAY,
      opacity: 20,
      notifications: "off",
      hotkey: "Ctrl+F9",
      enabled: false,
    });
  });
});

describe("overlay frame", () => {
  const screen = { width: 2048, height: 576 };
  it("covers the content and its shadow, inside the screen", () => {
    expect(frameFor([], screen)).toBeNull();
    // Widget top-left, a toast bottom-right: one box spanning both.
    expect(frameFor([{ x: 24, y: 24, width: 120.4, height: 100 }], screen)).toEqual({ x: 0, y: 0, width: 177, height: 156 });
    expect(frameFor([{ x: 24, y: 24, width: 120, height: 100 }, { x: 1684, y: 452, width: 340, height: 100 }], screen)).toEqual({ x: 0, y: 0, width: 2048, height: 576 });
    expect(frameFor([{ x: 1684, y: 452, width: 340, height: 100 }], screen)).toEqual({ x: 1652, y: 420, width: 396, height: 156 });
  });
});
