import type { RosterTarget } from "./types.js";

type Executor = (
  guildId: string,
  target: RosterTarget,
  reconcileMembers: boolean,
) => Promise<void>;

interface PendingRun {
  target: RosterTarget;
  timer: NodeJS.Timeout;
}

export class RosterScheduler {
  private readonly pending = new Map<string, PendingRun>();
  private readonly queues = new Map<string, Promise<void>>();
  private accepting = true;

  constructor(
    private readonly debounceMs: number,
    private readonly executor: Executor,
  ) {}

  schedule(guildId: string, target: RosterTarget): void {
    if (!this.accepting) {
      return;
    }
    const existing = this.pending.get(guildId);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const mergedTarget = mergeTargets(existing?.target, target);
    const timer = setTimeout(() => {
      this.pending.delete(guildId);
      void this.enqueue(guildId, mergedTarget, false).catch((error: unknown) => {
        console.error(`[roster] Automatic ${mergedTarget} refresh failed for ${guildId}:`, error);
      });
    }, this.debounceMs);
    timer.unref();
    this.pending.set(guildId, { target: mergedTarget, timer });
  }

  async runNow(
    guildId: string,
    target: RosterTarget,
    reconcileMembers = false,
  ): Promise<void> {
    if (!this.accepting) {
      throw new Error("The roster scheduler is shutting down.");
    }
    const pending = this.pending.get(guildId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(guildId);
      target = mergeTargets(pending.target, target);
    }
    await this.enqueue(guildId, target, reconcileMembers);
  }

  async stop(): Promise<void> {
    this.accepting = false;
    for (const run of this.pending.values()) {
      clearTimeout(run.timer);
    }
    this.pending.clear();
    await Promise.allSettled([...this.queues.values()]);
  }

  private async enqueue(
    guildId: string,
    target: RosterTarget,
    reconcileMembers: boolean,
  ): Promise<void> {
    const previous = this.queues.get(guildId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.executor(guildId, target, reconcileMembers));
    this.queues.set(guildId, current);

    try {
      await current;
    } finally {
      if (this.queues.get(guildId) === current) {
        this.queues.delete(guildId);
      }
    }
  }
}

function mergeTargets(
  left: RosterTarget | undefined,
  right: RosterTarget,
): RosterTarget {
  if (!left || left === right) {
    return right;
  }
  return "both";
}
