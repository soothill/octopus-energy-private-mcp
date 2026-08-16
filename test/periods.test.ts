import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { previousEquivalentPeriod, resolvePeriod } from "../src/periods.js";

describe("period resolution", () => {
  const now = DateTime.fromISO("2026-08-14T12:00:00", { zone: "Europe/London" });

  it("resolves a named local period to UTC", () => {
    const period = resolvePeriod({ period: "yesterday" }, "Europe/London", now);
    expect(period.from).toBe("2026-08-12T23:00:00.000Z");
    expect(period.to).toBe("2026-08-13T23:00:00.000Z");
  });

  it("treats a date-only end as inclusive", () => {
    const period = resolvePeriod(
      { period_from: "2026-01-01", period_to: "2026-01-02" },
      "Europe/London",
      now
    );
    expect(period.from).toBe("2026-01-01T00:00:00.000Z");
    expect(period.to).toBe("2026-01-03T00:00:00.000Z");
  });

  it("interprets offset-less timestamps in the configured timezone", () => {
    const local = resolvePeriod(
      { period_from: "2026-07-01T12:00", period_to: "2026-07-01T13:00" },
      "Europe/London",
      now
    );
    const explicitUtc = resolvePeriod(
      { period_from: "2026-07-01T12:00Z", period_to: "2026-07-01T13:00Z" },
      "Europe/London",
      now
    );

    expect(local.from).toBe("2026-07-01T11:00:00.000Z");
    expect(local.to).toBe("2026-07-01T12:00:00.000Z");
    expect(explicitUtc.from).toBe("2026-07-01T12:00:00.000Z");
  });

  it("creates an immediately preceding equivalent period", () => {
    const prior = previousEquivalentPeriod({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-08T00:00:00.000Z",
      label: "week"
    });
    expect(prior.from).toBe("2026-07-25T00:00:00.000Z");
    expect(prior.to).toBe("2026-08-01T00:00:00.000Z");
  });

  it("rejects partial and reversed custom periods", () => {
    expect(() => resolvePeriod({ period_from: "2026-01-01" }, "Europe/London", now)).toThrow(
      "must be supplied together"
    );
    expect(() => resolvePeriod(
      { period_from: "2026-01-03", period_to: "2026-01-01" },
      "Europe/London",
      now
    )).toThrow("must be after");
  });
});
