import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindIdleHide, IDLE_HIDE_MS } from "./idleHide";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

const bar = {};
function setup(held = false) {
  const stage = new EventTarget();
  const state = { idle: false, held };
  const dispose = bindIdleHide(stage, { isBar: t => t === bar, held: () => state.held, set: idle => (state.idle = idle) });
  const fire = (type: string, props: { clientX?: number; clientY?: number; target?: object } = {}) => {
    const e = Object.assign(new Event(type), { clientX: props.clientX, clientY: props.clientY });
    Object.defineProperty(e, "target", { value: props.target ?? stage });
    stage.dispatchEvent(e);
  };
  return { state, fire, dispose };
}
const wait = (ms: number) => vi.advanceTimersByTime(ms);

describe("call stage auto-hide", () => {
  it("goes idle after 3 s and wakes on pointer move or a key, restarting the timer", () => {
    const { state, fire } = setup();
    wait(IDLE_HIDE_MS - 1);
    expect(state.idle).toBe(false);
    wait(1);
    expect(state.idle).toBe(true);
    fire("pointermove", { clientX: 1, clientY: 1 });
    expect(state.idle).toBe(false);
    wait(IDLE_HIDE_MS);
    expect(state.idle).toBe(true);
    fire("keydown");
    expect(state.idle).toBe(false);
    wait(IDLE_HIDE_MS - 1);
    expect(state.idle).toBe(false);
    wait(1);
    fire("focusin");
    expect(state.idle).toBe(false);
  });

  it("a pointermove at the same position does not count as movement", () => {
    const { state, fire } = setup();
    fire("pointermove", { clientX: 5, clientY: 5 });
    wait(IDLE_HIDE_MS - 1);
    fire("pointermove", { clientX: 5, clientY: 5 });
    wait(1);
    expect(state.idle).toBe(true);
  });

  it("stays shown while the pointer is over a bar, and hides 3 s after it moves off", () => {
    const { state, fire } = setup();
    fire("pointermove", { clientX: 1, clientY: 1, target: bar });
    wait(IDLE_HIDE_MS * 3);
    expect(state.idle).toBe(false);
    fire("pointermove", { clientX: 9, clientY: 9 });
    wait(IDLE_HIDE_MS);
    expect(state.idle).toBe(true);
  });

  it("stays shown while held (menu open, focus in a bar) and hides once released", () => {
    const { state, fire } = setup(true);
    wait(IDLE_HIDE_MS * 3);
    expect(state.idle).toBe(false);
    state.held = false;
    wait(IDLE_HIDE_MS);
    expect(state.idle).toBe(true);
    fire("keydown");
    expect(state.idle).toBe(false);
  });

  it("leaving the stage hides at once unless held", () => {
    const a = setup();
    a.fire("pointermove", { clientX: 1, clientY: 1, target: bar });
    a.fire("pointerleave");
    expect(a.state.idle).toBe(true);
    const b = setup(true);
    b.fire("pointerleave");
    expect(b.state.idle).toBe(false);
  });

  it("dispose (paused, loading, error, phone) shows everything and stops the timer", () => {
    const { state, dispose } = setup();
    wait(IDLE_HIDE_MS);
    expect(state.idle).toBe(true);
    dispose();
    expect(state.idle).toBe(false);
    wait(IDLE_HIDE_MS * 2);
    expect(state.idle).toBe(false);
  });
});
