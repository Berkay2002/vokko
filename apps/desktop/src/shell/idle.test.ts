import { describe, expect, it, vi } from "vitest";
import { IDLE_AFTER_MS, createIdle } from "./idle";
import type { SelectableStatus } from "./actions";

function setup(chosen: SelectableStatus = "online") {
  const env = { t: 0, chosen, connected: true, voice: false, send: vi.fn() };
  const idle = createIdle({ now: () => env.t, chosen: () => env.chosen, connected: () => env.connected, inVoice: () => env.voice, send: env.send });
  return { env, idle };
}

describe("automatic Idle", () => {
  it("goes Idle after ten minutes without input and back to Online on the next input", () => {
    const { env, idle } = setup();
    env.t = IDLE_AFTER_MS - 1;
    idle.check();
    expect(env.send).not.toHaveBeenCalled();
    env.t = IDLE_AFTER_MS;
    idle.check();
    idle.check();
    expect(env.send.mock.calls).toEqual([[true]]);
    idle.input();
    expect(env.send.mock.calls).toEqual([[true], [false]]);
    idle.input();
    expect(env.send).toHaveBeenCalledTimes(2);
  });

  it("input restarts the countdown", () => {
    const { env, idle } = setup();
    env.t = IDLE_AFTER_MS - 1;
    idle.input();
    env.t = IDLE_AFTER_MS * 1.5;
    idle.check();
    expect(env.send).not.toHaveBeenCalled();
  });

  it("never overrides a status the user picked", () => {
    for (const chosen of ["dnd", "invisible", "idle"] as const) {
      const { env, idle } = setup(chosen);
      env.t = IDLE_AFTER_MS * 2;
      idle.check();
      expect(env.send).not.toHaveBeenCalled();
    }
  });

  it("keeps a status picked while Idle instead of sending Online", () => {
    const { env, idle } = setup();
    env.t = IDLE_AFTER_MS;
    idle.check();
    env.chosen = "dnd";
    idle.input();
    expect(env.send.mock.calls).toEqual([[true]]);
    expect(idle.idle).toBe(false);
  });

  it("stays Online in a voice channel and while disconnected", () => {
    const { env, idle } = setup();
    env.voice = true;
    env.t = IDLE_AFTER_MS * 3;
    idle.check();
    expect(env.send).not.toHaveBeenCalled();
    env.voice = false;
    env.t += IDLE_AFTER_MS - 1;
    idle.check();
    expect(env.send).not.toHaveBeenCalled();
    env.connected = false;
    env.t += 1;
    idle.check();
    expect(env.send).not.toHaveBeenCalled();
  });

  it("says Idle again on a new session", () => {
    const { env, idle } = setup();
    idle.resync();
    expect(env.send).not.toHaveBeenCalled();
    env.t = IDLE_AFTER_MS;
    idle.check();
    idle.resync();
    expect(env.send.mock.calls).toEqual([[true], [true]]);
  });
});
