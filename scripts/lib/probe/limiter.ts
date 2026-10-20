/**
 * The probe's own pacing and budget guards (it deliberately does not use the
 * product client, so it can run on day one with nothing else built).
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Spaces request starts at least 1000/rate ms apart. Calls are serial in the probe. */
export class RateLimiter {
  private nextAt = 0;
  private readonly intervalMs: number;

  constructor(
    ratePerSecond: number,
    private readonly clock: Clock = realClock,
  ) {
    if (!(ratePerSecond > 0)) throw new RangeError("ratePerSecond must be > 0");
    this.intervalMs = 1000 / ratePerSecond;
  }

  async acquire(): Promise<void> {
    const now = this.clock.now();
    const startAt = Math.max(now, this.nextAt);
    this.nextAt = startAt + this.intervalMs;
    const wait = startAt - now;
    if (wait > 0) await this.clock.sleep(wait);
  }
}

export class BudgetExceededError extends Error {
  constructor(public readonly max: number) {
    super(`call budget of ${max} reached; aborting the run`);
    this.name = "BudgetExceededError";
  }
}

export class QuotaGuardError extends Error {
  constructor(
    public readonly remaining: number,
    public readonly floor: number,
  ) {
    super(`monthly quota remaining (${remaining}) is below the floor (${floor}); aborting the run`);
    this.name = "QuotaGuardError";
  }
}

/** Hard cap on HTTP attempts (retries included). take() throws once the cap is reached. */
export class CallBudget {
  private usedCount = 0;

  constructor(public readonly max: number) {
    if (!(Number.isInteger(max) && max > 0)) throw new RangeError("budget must be a positive integer");
  }

  get used(): number {
    return this.usedCount;
  }

  get remaining(): number {
    return this.max - this.usedCount;
  }

  take(): void {
    if (this.usedCount >= this.max) throw new BudgetExceededError(this.max);
    this.usedCount++;
  }
}
