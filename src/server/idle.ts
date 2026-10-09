// Idle grace (ADR 0001, plan M4.8): the daemon stops when its last link has
// been gone for idleGraceMs. Open panels do not keep it alive. The timers are
// injected, so tests drive a fake clock.

/** The autostart poll limit (M4.6): a new daemon waits at least this long for its first link. */
export const BOOT_GRACE_MIN_MS = 10_000;

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

export class IdleTimer {
  private handle: unknown = null;
  private fired = false;

  /** graceMs null: the idle stop is off, and the timer never fires. */
  constructor(
    private graceMs: number | null,
    private onIdle: () => void,
    private timers: Timers = realTimers,
  ) {}

  /** At boot, no link yet: wait max(grace, BOOT_GRACE_MIN_MS) for the first relay. */
  boot(): void {
    if (this.graceMs === null) return;
    this.start(Math.max(this.graceMs, BOOT_GRACE_MIN_MS));
  }

  /** The link count went to 0. */
  arm(): void {
    if (this.graceMs === null) return;
    this.start(this.graceMs);
  }

  /** A link was accepted. */
  disarm(): void {
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = null;
  }

  get armed(): boolean {
    return this.handle !== null;
  }

  private start(ms: number): void {
    if (this.fired) return;
    this.disarm();
    this.handle = this.timers.set(() => {
      this.handle = null;
      if (this.fired) return;
      this.fired = true;
      this.onIdle();
    }, ms);
  }
}
