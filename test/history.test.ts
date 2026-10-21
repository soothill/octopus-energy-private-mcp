import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEngineRuntime } from "../src/history.js";
import { HistoryEngine } from "../src/history.js";
import type { MeterSelector, TariffRateKind } from "../src/octopus-client.js";
import { HistoryStore } from "../src/store.js";
import type {
  ConsumptionRecord,
  Fuel,
  MeterDescriptor,
  RateRecord
} from "../src/types.js";
import { testConfig } from "./helpers.js";

let storageDir: string;

beforeEach(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "octopus-history-"));
});

afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

function consumptionRecord(startIso: string, kWh: number): ConsumptionRecord {
  const end = new Date(Date.parse(startIso) + 30 * 60 * 1000).toISOString();
  return { consumption: kWh, interval_start: startIso, interval_end: end };
}

const DAY = "2025-06-02";
function dayOfHalfHours(kWhPerInterval = 0.5): ConsumptionRecord[] {
  return Array.from({ length: 48 }, (_, index) =>
    consumptionRecord(
      `${DAY}T${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}:00Z`,
      kWhPerInterval
    )
  );
}

function testMeter(direction: "import" | "export" = "import"): MeterDescriptor {
  return {
    property_id: 1,
    property_active: true,
    fuel: "electricity",
    direction,
    meter_point: "1100000111111",
    serial_number: "11A2223344",
    agreements: [
      { tariff_code: "E-1R-VAR-25-01-01-B", valid_from: "2025-01-01T00:00:00Z", valid_to: null }
    ],
    active_tariff_code: "E-1R-VAR-25-01-01-B",
    consumption_standard: null
  };
}

function rate(valueIncVat: number, validFromIso = `${DAY}T00:00:00Z`): RateRecord {
  return {
    value_exc_vat: valueIncVat / 1.05,
    value_inc_vat: valueIncVat,
    valid_from: validFromIso,
    valid_to: "2025-06-03T00:00:00Z",
    payment_method: null
  };
}

interface RestMock {
  getConsumption: ReturnType<typeof vi.fn>;
  getTariffRates: ReturnType<typeof vi.fn>;
  selectMeter: ReturnType<typeof vi.fn>;
}

function restMock(overrides: Partial<RestMock> = {}): { rest: HistoryEngineRuntime["rest"] } & RestMock {
  const meter = testMeter();
  const getConsumption =
    overrides.getConsumption ??
    vi.fn(async () => ({
      meter,
      data: {
        count: 48,
        results: dayOfHalfHours(),
        pages_fetched: 1,
        truncated: false,
        cache_status: "disabled",
        stale_cache_used: false
      }
    }));
  const getTariffRates =
    overrides.getTariffRates ??
    vi.fn(async (target: { tariff_code: string }, kind: TariffRateKind) => ({
      count: 1,
      results: [rate(kind === "unit" ? (target.tariff_code.includes("PRICEY") ? 20 : 10) : 50)],
      pages_fetched: 1,
      truncated: false,
      cache_status: "disabled",
      stale_cache_used: false
    }));
  const selectMeter = overrides.selectMeter ?? vi.fn(async (_selector?: MeterSelector) => meter);
  return { getConsumption, getTariffRates, selectMeter, rest: { getConsumption, getTariffRates, selectMeter } as HistoryEngineRuntime["rest"] };
}

function engineConfig() {
  return testConfig({
    cacheDir: storageDir,
    historyEnabled: true,
    historyBackfillYears: 3,
    cacheEnabled: false,
    gasConsumptionUnit: "auto"
  });
}

describe("HistoryStore", () => {
  it("stores, deduplicates, and reads consumption series", async () => {
    const store = new HistoryStore(join(storageDir, "dedupe"), true);
    const key = HistoryStore.consumptionKey({
      site: "york",
      fuel: "electricity",
      direction: "import",
      meter_point: "1100000111111",
      serial_number: "11A2223344"
    });

    const first = await store.writeConsumption(key, [
      consumptionRecord("2025-06-02T00:00:00Z", 0.5),
      consumptionRecord("2025-06-02T00:30:00Z", 0.7)
    ]);
    expect(first.records).toBe(2);

    // Re-writing the same interval replaces its value without counting as new.
    const revised = await store.writeConsumption(key, [consumptionRecord("2025-06-02T00:00:00Z", 0.9)]);
    expect(revised.added).toBe(0);
    expect(revised.records).toBe(2);

    const all = await store.readConsumption(key, Date.parse("2025-06-02T00:00:00Z"), Date.parse("2025-06-03T00:00:00Z"));
    expect(all.records.map((record) => record.consumption)).toEqual([0.9, 0.7]);

    await store.recordHole("consumption", key, "2025-06-02T00:00:00Z", "2025-06-03T00:00:00Z", Date.now());
    expect(Object.keys(await store.holes("consumption", key))).toHaveLength(1);

    const info = await store.seriesInfo();
    expect(info).toHaveLength(1);
    expect(info[0]!.key).toBe(key);
  });

  it("deduplicates rates by validity and payment method", async () => {
    const store = new HistoryStore(join(storageDir, "rates"), true);
    const key = HistoryStore.ratesKey({ product_code: "VAR-25-01-01", tariff_code: "E-1R-VAR-25-01-01-B", kind: "unit" });
    await store.writeRates(key, [rate(10)]);
    const revised = await store.writeRates(key, [rate(12)]);
    expect(revised.added).toBe(0);
    expect(revised.records).toBe(1);
    const read = await store.readRates(key);
    expect(read.records[0]!.value_inc_vat).toBe(12);
  });

  it("is inert when disabled", async () => {
    const store = new HistoryStore(join(storageDir, "disabled"), false);
    const written = await store.writeConsumption("consumption:x", [consumptionRecord("2025-06-02T00:00:00Z", 1)]);
    expect(written.added).toBe(0);
    expect(await store.readConsumption("consumption:x")).toEqual({ records: [], manifest: null });
    expect(await store.seriesInfo()).toEqual([]);
  });
});

describe("HistoryEngine what-if", () => {
  const range = { from: `${DAY}T00:00:00Z`, to: "2025-06-03T00:00:00Z", label: "explicit" };

  it("ranks tariff scenarios from the store and repeats the replay with zero API calls", async () => {
    const mocks = restMock();
    const store = new HistoryStore(join(storageDir, "whatif"), true);
    const engine = new HistoryEngine({ rest: mocks.rest, config: engineConfig() }, store);

    const result = await engine.whatIfUsage({
      meter: testMeter(),
      range,
      scenarios: [
        { tariff_code: "E-1R-VAR-25-01-01-B", label: "cheap" },
        { tariff_code: "E-1R-PRICEY-25-01-01-B", label: "pricey" }
      ],
      include_standing_charges: true
    });

    expect(result.consumption.complete).toBe(true);
    expect(result.consumption.records).toBe(48);
    const sortedPrices = result.scenarios.map((scenario) => scenario.estimate.total_cost_gbp);
    expect(sortedPrices).toEqual([2.9, 5.3]);
    expect(result.cheapest?.tariff_code).toBe("E-1R-VAR-25-01-01-B");
    expect(result.api_requests).toEqual({ consumption_pages: 1, rate_pages: 4 });
    expect(mocks.getConsumption).toHaveBeenCalledTimes(1);
    expect(mocks.getTariffRates).toHaveBeenCalledTimes(4);

    // Fresh engine over the same store: the replay is fully local now.
    const second = new HistoryEngine({ rest: mocks.rest, config: engineConfig() }, store);
    const replay = await second.whatIfUsage({
      meter: testMeter(),
      range,
      scenarios: [{ tariff_code: "E-1R-VAR-25-01-01-B", label: "cheap" }],
      include_standing_charges: true
    });
    expect(replay.scenarios[0]!.estimate.total_cost_gbp).toBeCloseTo(2.9, 2);
    expect(replay.api_requests).toEqual({ consumption_pages: 0, rate_pages: 0 });
    expect(mocks.getConsumption).toHaveBeenCalledTimes(1);
    expect(mocks.getTariffRates).toHaveBeenCalledTimes(4);
  });

  it("warns and replays best effort when history stays incomplete", async () => {
    const partial = Array.from({ length: 20 }, (_, index) =>
      consumptionRecord(`${DAY}T${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}:00Z`, 0.5)
    );
    const mocks = restMock({
      getConsumption: vi.fn(async () => ({
        meter: testMeter(),
        data: {
          count: 20,
          results: partial,
          pages_fetched: 1,
          truncated: false,
          cache_status: "disabled",
          stale_cache_used: false
        }
      }))
    });
    const store = new HistoryStore(join(storageDir, "partial"), true);
    const engine = new HistoryEngine({ rest: mocks.rest, config: engineConfig() }, store);
    const result = await engine.whatIfUsage({
      meter: testMeter(),
      range,
      scenarios: [{ tariff_code: "E-1R-VAR-25-01-01-B" }],
      include_standing_charges: true
    });
    expect(result.consumption.complete).toBe(false);
    expect(result.consumption.records).toBe(20);
    expect(result.warnings.some((warning) => warning.includes("incomplete"))).toBe(true);
  });

  it("refuses export meters and mismatched tariff fuels", async () => {
    const store = new HistoryStore(join(storageDir, "refusals"), true);
    const exportMeter = testMeter("export");
    const mocks = restMock({ selectMeter: vi.fn(async (_selector?: MeterSelector) => exportMeter) });
    const engine = new HistoryEngine({ rest: mocks.rest, config: engineConfig() }, store);
    await expect(
      engine.whatIfUsage({
        meter_selector: {},
        range,
        scenarios: [{ tariff_code: "E-1R-VAR-25-01-01-B" }],
        include_standing_charges: true
      })
    ).rejects.toThrow("import meters only");

    const importingEngine = new HistoryEngine({ rest: restMock().rest, config: engineConfig() }, store);
    await expect(
      importingEngine.whatIfUsage({
        meter: testMeter(),
        range,
        scenarios: [{ tariff_code: "G-1R-VAR-25-01-01-B", fuel: "gas" as Fuel }],
        include_standing_charges: true
      })
    ).rejects.toThrow("gas tariff");
  });

  it("syncs tariff rate history and backfills consumption", async () => {
    const mocks = restMock({
      getConsumption: vi.fn(async () => ({
        meter: testMeter(),
        data: {
          count: 48,
          results: dayOfHalfHours(),
          pages_fetched: 2,
          truncated: false,
          cache_status: "disabled",
          stale_cache_used: false
        }
      }))
    });
    const store = new HistoryStore(join(storageDir, "sync"), true);
    const engine = new HistoryEngine({ rest: mocks.rest, config: engineConfig() }, store);

    const rateOutcomes = await engine.syncTariff({ tariff_code: "E-1R-VAR-25-01-01-B", fuel: "electricity" });
    expect(rateOutcomes).toHaveLength(2);
    expect(rateOutcomes.every((outcome) => outcome.kind === "rates" && outcome.rate_kind)).toBe(true);

    const consumptionOutcome = await engine.syncConsumption(testMeter(), "2025-06-01T00:00:00Z");
    expect(consumptionOutcome.records).toBe(48);
    expect(consumptionOutcome.kind).toBe("consumption");
  });
});
