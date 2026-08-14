export interface RateLimiterSnapshot {
  requests_last_minute: number;
  configured_requests_per_minute: number;
  minimum_interval_ms: number;
  queued_requests: number;
  total_acquired: number;
}

export class RequestRateLimiter {
  private timestamps: number[] = [];
  private lastRequestAt = 0;
  private queueTail: Promise<void> = Promise.resolve();
  private queued = 0;
  private totalAcquired = 0;

  constructor(
    readonly requestsPerMinute: number,
    readonly minimumIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds))
  ) {}

  acquire(): Promise<void> {
    this.queued += 1;
    const operation = this.queueTail.then(async () => {
      try {
        await this.waitForSlot();
      } finally {
        this.queued -= 1;
      }
    });
    this.queueTail = operation.catch(() => undefined);
    return operation;
  }

  private async waitForSlot(): Promise<void> {
    while (true) {
      const now = this.now();
      this.timestamps = this.timestamps.filter((value) => now - value < 60_000);
      const intervalWait = Math.max(0, this.lastRequestAt + this.minimumIntervalMs - now);
      const windowWait =
        this.timestamps.length >= this.requestsPerMinute
          ? Math.max(0, (this.timestamps[0] ?? now) + 60_000 - now)
          : 0;
      const wait = Math.max(intervalWait, windowWait);
      if (wait <= 0) {
        const acquiredAt = this.now();
        this.timestamps.push(acquiredAt);
        this.lastRequestAt = acquiredAt;
        this.totalAcquired += 1;
        return;
      }
      await this.sleep(wait);
    }
  }

  snapshot(): RateLimiterSnapshot {
    const now = this.now();
    this.timestamps = this.timestamps.filter((value) => now - value < 60_000);
    return {
      requests_last_minute: this.timestamps.length,
      configured_requests_per_minute: this.requestsPerMinute,
      minimum_interval_ms: this.minimumIntervalMs,
      queued_requests: this.queued,
      total_acquired: this.totalAcquired
    };
  }
}
