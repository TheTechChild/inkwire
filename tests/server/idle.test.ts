// Idle grace (plan M4.8) with a fake clock.
import { describe, expect, it } from "vitest";
import { BOOT_GRACE_MIN_MS, IdleTimer, type Timers } from "../../src/server/idle.js";
import { loadConfig } from "../../src/server/config.js";

class FakeTimers implements Timers {
  now = 0;
  private next = 1;
  private due = new Map<number, { at: number; fn: () => void }>();
  set(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.due.set(id, { at: this.now + ms, fn });
    return id;
  }
  clear(h: unknown): void {
    this.due.delete(h as number);
  }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const first = [...this.due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      this.due.delete(first[0]);
      this.now = first[1].at;
      first[1].fn();
    }
    this.now = end;
  }
}

function setup(grace: number | null) {
  const timers = new FakeTimers();
  let fired = 0;
  const idle = new IdleTimer(grace, () => fired++, timers);
  return { timers, idle, fired: () => fired };
}

describe("IdleTimer", () => {
  it("at boot it does not fire before max(grace, 10 s)", () => {
    const { timers, idle, fired } = setup(300);
    idle.boot();
    timers.advance(BOOT_GRACE_MIN_MS - 1);
    expect(fired()).toBe(0);
    timers.advance(1);
    expect(fired()).toBe(1);
  });

  it("at boot a grace longer than 10 s is used as it is", () => {
    const { timers, idle, fired } = setup(30_000);
    idle.boot();
    timers.advance(29_999);
    expect(fired()).toBe(0);
    timers.advance(1);
    expect(fired()).toBe(1);
  });

  it("arms at 0 links, disarms on connect, arms again on the last close, and fires once", () => {
    const { timers, idle, fired } = setup(300);
    idle.boot();
    idle.disarm(); // the first relay connects
    timers.advance(60_000);
    expect(fired()).toBe(0);
    idle.arm(); // the last link closed
    timers.advance(299);
    idle.disarm(); // a relay connects in the grace
    timers.advance(10_000);
    expect(fired()).toBe(0);
    idle.arm();
    expect(idle.armed).toBe(true);
    timers.advance(300);
    expect(fired()).toBe(1);
    idle.arm();
    timers.advance(10_000);
    expect(fired()).toBe(1);
  });

  it("off never fires", () => {
    const { timers, idle, fired } = setup(null);
    idle.boot();
    idle.arm();
    timers.advance(10 * 60_000);
    expect(fired()).toBe(0);
    expect(idle.armed).toBe(false);
  });
});

describe("INKWIRE_IDLE_GRACE_MS", () => {
  it("defaults to 30000, takes a number, and off turns it off", () => {
    expect(loadConfig({}).idleGraceMs).toBe(30_000);
    expect(loadConfig({ INKWIRE_IDLE_GRACE_MS: "300" }).idleGraceMs).toBe(300);
    expect(loadConfig({ INKWIRE_IDLE_GRACE_MS: "off" }).idleGraceMs).toBeNull();
  });
});
