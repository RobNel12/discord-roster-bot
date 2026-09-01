import { afterEach, describe, expect, it, vi } from "vitest";

import { RosterScheduler } from "../src/scheduler.js";

describe("RosterScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces and merges role and squad events into one refresh", async () => {
    vi.useFakeTimers();
    const calls: Array<[string, string, boolean]> = [];
    const scheduler = new RosterScheduler(2_000, async (guildId, target, reconcile) => {
      calls.push([guildId, target, reconcile]);
    });

    scheduler.schedule("guild-1", "role");
    scheduler.schedule("guild-1", "squad");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(calls).toEqual([["guild-1", "both", false]]);
    await scheduler.stop();
  });

  it("passes explicit reconciliation through immediate runs", async () => {
    const calls: Array<[string, string, boolean]> = [];
    const scheduler = new RosterScheduler(2_000, async (guildId, target, reconcile) => {
      calls.push([guildId, target, reconcile]);
    });

    await scheduler.runNow("guild-1", "role", true);
    expect(calls).toEqual([["guild-1", "role", true]]);
  });

  it("drains active work and rejects new immediate work during shutdown", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new RosterScheduler(2_000, async () => blocked);
    const activeRun = scheduler.runNow("guild-1", "role");
    await Promise.resolve();

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await expect(scheduler.runNow("guild-1", "squad")).rejects.toThrow("shutting down");

    release?.();
    await activeRun;
    await stopping;
    expect(stopped).toBe(true);
  });
});
