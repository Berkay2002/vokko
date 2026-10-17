import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEEK_DEBOUNCE_MS, SeekCoalescer } from "./seek";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

function setup(send: (ms: number) => Promise<unknown> = () => Promise.resolve()) {
  const sent = vi.fn(send);
  const failed = vi.fn();
  const changed = vi.fn();
  return { sent, failed, changed, seeker: new SeekCoalescer(sent, changed, failed) };
}

describe("seek coalescing", () => {
  it("shows the target at once and sends one PATCH for a burst of presses", async () => {
    const { seeker, sent } = setup();
    seeker.nudge(10_000, 60_000);
    expect(seeker.target).toBe(70_000);
    // The next press counts from what is shown, not from the server's position.
    seeker.nudge(10_000, 60_000);
    seeker.nudge(10_000, 60_000);
    expect(seeker.target).toBe(90_000);
    expect(sent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SEEK_DEBOUNCE_MS);
    expect(sent.mock.calls).toEqual([[90_000]]);
    expect(seeker.target).toBeNull();
  });

  it("clamps a nudge to the video and sends a drag right away", async () => {
    const { seeker, sent } = setup();
    seeker.nudge(-10_000, 4_000);
    expect(seeker.target).toBe(0);
    seeker.nudge(10_000, 0, 0, 5_000);
    expect(seeker.target).toBe(5_000);
    seeker.seek(42_000, true);
    expect(sent).toHaveBeenCalledWith(42_000);
    await vi.advanceTimersByTimeAsync(SEEK_DEBOUNCE_MS);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer target while an older PATCH is in flight", async () => {
    let finish: () => void = () => undefined;
    const { seeker, sent } = setup(() => new Promise<void>(resolve => (finish = resolve)));
    seeker.seek(30_000);
    await vi.advanceTimersByTimeAsync(SEEK_DEBOUNCE_MS);
    seeker.seek(50_000);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(seeker.target).toBe(50_000);
    await vi.advanceTimersByTimeAsync(SEEK_DEBOUNCE_MS);
    expect(sent.mock.calls).toEqual([[30_000], [50_000]]);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(seeker.target).toBeNull();
  });

  it("goes back to the server's position and reports when the PATCH fails", async () => {
    const { seeker, failed, changed } = setup(() => Promise.reject(new Error("nope")));
    seeker.seek(30_000, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(seeker.target).toBeNull();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
