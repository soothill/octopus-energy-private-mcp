import { describe, expect, it } from "vitest";
import { RequestRateLimiter } from "../src/rate-limiter.js";

describe("request rate limiter", () => {
  it("serialises requests and enforces interval and rolling-minute caps", async () => {
    let now = 100_000;
    const waits: number[] = [];
    const limiter = new RequestRateLimiter(
      2,
      100,
      () => now,
      async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      }
    );
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    expect(waits).toEqual([100, 59_900]);
    expect(limiter.snapshot().total_acquired).toBe(3);
    expect(limiter.snapshot().queued_requests).toBe(0);
  });
});
