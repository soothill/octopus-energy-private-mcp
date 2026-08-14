import { describe, expect, it } from "vitest";
import {
  analyseUsage,
  compareAnalyses,
  estimateCost,
  findCheapestWindows,
  normalizeConsumption
} from "../src/analytics.js";
import type { ConsumptionRecord, RateRecord } from "../src/types.js";

const consumption: ConsumptionRecord[] = [
  { consumption: 1, interval_start: "2026-01-01T00:00:00Z", interval_end: "2026-01-01T00:30:00Z" },
  { consumption: 2, interval_start: "2026-01-01T00:30:00Z", interval_end: "2026-01-01T01:00:00Z" },
  { consumption: 3, interval_start: "2026-01-01T01:30:00Z", interval_end: "2026-01-01T02:00:00Z" }
];

const unitRates: RateRecord[] = [
  { value_exc_vat: 10, value_inc_vat: 12, valid_from: "2026-01-01T00:00:00Z", valid_to: "2026-01-01T00:30:00Z", payment_method: null },
  { value_exc_vat: 20, value_inc_vat: 24, valid_from: "2026-01-01T00:30:00Z", valid_to: "2026-01-01T01:00:00Z", payment_method: null },
  { value_exc_vat: 30, value_inc_vat: 36, valid_from: "2026-01-01T01:30:00Z", valid_to: "2026-01-01T02:00:00Z", payment_method: null }
];

describe("usage analytics", () => {
  it("summarises totals, peaks, buckets and gaps", () => {
    const analysis = analyseUsage(
      consumption,
      "electricity",
      "Europe/London",
      "auto",
      11.184,
      { from: "2026-01-01T00:00:00Z", to: "2026-01-01T02:00:00Z" }
    );
    expect(analysis.total).toBe(6);
    expect(analysis.unit).toBe("kWh");
    expect(analysis.peak_intervals[0]?.consumption).toBe(3);
    expect(analysis.by_day[0]?.consumption).toBe(6);
    expect(analysis.data_quality.gaps).toHaveLength(1);
    expect(analysis.data_quality.gaps[0]?.minutes).toBe(30);
    expect(analysis.data_quality.coverage_percent).toBe(75);
  });

  it("converts configured gas volume and warns about estimation", () => {
    const normalized = normalizeConsumption(consumption.slice(0, 1), "gas", "m3", 11.184);
    expect(normalized.records[0]?.consumption).toBe(11.184);
    expect(normalized.unit).toBe("kWh");
    expect(normalized.warnings[0]).toContain("estimate");
  });

  it("reports a period comparison", () => {
    const current = analyseUsage(consumption, "electricity", "UTC", "auto", 11.184);
    const previous = analyseUsage(consumption.slice(0, 2), "electricity", "UTC", "auto", 11.184);
    expect(compareAnalyses(current, previous).percent_change).toBe(100);
  });
});

describe("tariff analytics", () => {
  it("matches interval rates and adds one daily standing charge", () => {
    const standing: RateRecord[] = [{
      value_exc_vat: 40,
      value_inc_vat: 42,
      valid_from: "2025-12-01T00:00:00Z",
      valid_to: null,
      payment_method: null
    }];
    const result = estimateCost(
      consumption,
      unitRates,
      standing,
      { fuel: "electricity", product_code: "TEST", tariff_code: "E-1R-TEST-A" },
      "UTC"
    );
    expect(result.unit_cost_pence).toBe(168);
    expect(result.standing_charge_pence).toBe(42);
    expect(result.total_cost_gbp).toBe(2.1);
    expect(result.rate_coverage_percent).toBe(100);
  });

  it("finds only contiguous cheapest windows", () => {
    const windows = findCheapestWindows(unitRates, 2, 5);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.average_pence_per_kwh).toBe(18);
    expect(windows[0]?.start).toBe("2026-01-01T00:00:00Z");
  });

  it("charges standing rates for every requested local day even when readings are missing", () => {
    const standing: RateRecord[] = [{
      value_exc_vat: 40,
      value_inc_vat: 42,
      valid_from: "2025-12-01T00:00:00Z",
      valid_to: null,
      payment_method: null
    }];
    const result = estimateCost(
      consumption,
      unitRates,
      standing,
      { fuel: "electricity", product_code: "TEST", tariff_code: "E-1R-TEST-A" },
      "UTC",
      { from: "2026-01-01T00:00:00Z", to: "2026-01-03T00:00:00Z" }
    );
    expect(result.standing_charge_days).toBe(2);
    expect(result.standing_charge_pence).toBe(84);
  });
});
