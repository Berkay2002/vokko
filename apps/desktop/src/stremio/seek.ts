// Seeking that feels instant: the bar and the clock jump to the target at once (`target`), presses within DEBOUNCE_MS become one
// PATCH to the last target, and each +-10 s press counts from the target already shown rather than from the server's position.
// The target is dropped when the PATCH comes back (the server's own position takes over) or fails (the bar goes back).

export const SEEK_DEBOUNCE_MS = 250;

export class SeekCoalescer {
  /** Where the user wants to be, or null when nothing is pending. */
  target: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly send: (ms: number) => Promise<unknown>,
    private readonly changed: () => void,
    private readonly failed: (error: unknown) => void,
  ) {}

  /** Jump to `ms`. `immediate` sends now (the end of a drag); otherwise a quick follow-up press still folds into this one. */
  seek(ms: number, immediate = false): void {
    this.target = ms;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.changed();
    if (immediate) this.flush();
    else this.timer = setTimeout(() => this.flushNow(), SEEK_DEBOUNCE_MS);
  }

  /** A +-`delta` press; `from` is the position shown when nothing is pending. */
  nudge(delta: number, from: number, min = 0, max = Number.POSITIVE_INFINITY): void {
    this.seek(Math.max(min, Math.min(max, (this.target ?? from) + delta)));
  }

  /** The tile is going away: a press still waiting for its PATCH is sent now rather than lost. */
  flushNow(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.flush();
  }

  private flush(): void {
    const sent = this.target;
    if (sent === null) return;
    const done = (error?: unknown) => {
      // A newer target is still waiting for its own PATCH; only the last one hands the bar back to the server.
      if (this.target === sent) {
        this.target = null;
        this.changed();
      }
      if (error !== undefined) this.failed(error);
    };
    this.send(sent).then(
      () => done(),
      error => done(error ?? new Error("seek failed")),
    );
  }
}
