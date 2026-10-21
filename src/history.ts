import { DateTime } from "luxon";
import { estimateCost, normalizeConsumption } from "./analytics.js";
import type { ServerConfig } from "./config.js";
import { productCodeFromTariff } from "./octopus-client.js";
import type { MeterSelector } from "./octopus-client.js";
import { HistoryStore } from "./store.js";
import type {
  CostEstimate,
  ConsumptionRecord,
  Fuel,
  GasConsumptionUnit,
  MeterDescriptor,
  PeriodRange,
  RateRecord,
  TariffTarget
} from "./types.js";

/** Minimal client surface the engine needs; works with mocks in tests too. */
export interface HistoryEngineRuntime {
  rest: Pick<
    import("./octopus-client.js").OctopusRestClient,
    "getConsumption" | "getTariffRates" | "selectMeter"
  >;
  config: ServerConfig;
}

export interface YearWindow {
  fromIso: string;
  toIso: string;
}

export interface SyncOutcome {
  key: string;
  kind: "consumption" | "rates";
  meter_point?: string;
  serial_number?: string;
  tariff_code?: string;
  product_code?: string;
  rate_kind?: "unit" | "standing";
  added: number;
  records: number;
  earliest: string | null;
  latest: string | null;
  api_pages: number;
}

export interface ConsumptionProvenance {
  source: "local_history_store";
  records: number;
  complete: boolean;
  expected_intervals: number | null;
  api_pages: number;
}

export interface RatesProvenance {
  records: number;
  complete: boolean;
  api_pages: number;
}

export interface WhatIfScenario {
  label: string;
  tariff_code: string;
  product_code: string;
  fuel: Fuel;
  estimate: CostEstimate;
  rate_provenance: { unit: RatesProvenance; standing: RatesProvenance | null };
}

export interface WhatIfResult {
  meter: MeterDescriptor;
  requested_period: PeriodRange;
  data_source: "local_history_store";
  consumption: ConsumptionProvenance;
  scenarios: WhatIfScenario[];
  cheapest: { label: string; tariff_code: string; total_cost_gbp: number } | null;
  api_requests: { consumption_pages: number; rate_pages: number };
  warnings: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CONSUMPTION_TAIL_MS = 2 * DAY_MS;
const RATES_TAIL_MS = DAY_MS;
const HOLE_RETRY_TTL_HOURS = 24;

export class HistoryEngine {
  constructor(
    private readonly runtime: HistoryEngineRuntime,
    readonly store: HistoryStore
  ) {}

  private get config(): ServerConfig {
    return this.runtime.config;
  }

  consumptionKey(meter: MeterDescriptor): string {
    return HistoryStore.consumptionKey({
      site: this.config.siteId,
      fuel: meter.fuel,
      direction: meter.direction,
      meter_point: meter.meter_point,
      serial_number: meter.serial_number
    });
  }

  private static ratesKey(target: { product_code: string; tariff_code: string }, kind: string): string {
    return HistoryStore.ratesKey({ product_code: target.product_code, tariff_code: target.tariff_code, kind });
  }

  /** Chunk an inclusive span into UTC-year windows so one paginated call stays under maxPagesPerCall. */
  static yearWindows(fromMs: number, toMs: number): YearWindow[] {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) return [];
    const windows: YearWindow[] = [];
    let cursor = fromMs;
    while (cursor <= toMs) {
      const start = DateTime.fromMillis(cursor).toUTC();
      const yearEnd = DateTime.utc(start.year, 12, 31, 23, 59, 59, 999).toMillis();
      const windowEndMs = Math.min(yearEnd, toMs);
      const fromIso = start.toISO();
      const toIso = DateTime.fromMillis(windowEndMs).toUTC().toISO();
      if (!fromIso || !toIso) break;
      windows.push({ fromIso, toIso });
      cursor = windowEndMs + 1;
    }
    return windows;
  }

  private earliestAgreementStart(meter: MeterDescriptor): DateTime | null {
    const values = meter.agreements
      .map((agreement) => Date.parse(agreement.valid_from))
      .filter((value) => Number.isFinite(value));
    if (values.length === 0) return null;
    return DateTime.fromMillis(Math.min(...values)).toUTC();
  }

  private defaultBackfillStart(): DateTime {
    const years = Math.max(0, this.config.historyBackfillYears ?? 3);
    return DateTime.utc().minus({ years }).startOf("day");
  }

  /**
   * Coverage plan for a span against a stored series: backfill head (before the
   * earliest stored point), interior request window, and a tail refresh to pick
   * up late corrections. When nothing is stored yet, the whole span is needed.
   */
  private static coverageSpanWindows(
    manifestEarliestMs: number | null,
    manifestLatestMs: number | null,
    requestFromMs: number,
    requestToMs: number,
    tailMs: number
  ): YearWindow[] {
    if (manifestEarliestMs === null || manifestLatestMs === null) {
      return HistoryEngine.yearWindows(requestFromMs, requestToMs);
    }
    const windows: YearWindow[] = [];
    if (requestFromMs < manifestEarliestMs) {
      const headEnd = Math.min(manifestEarliestMs, requestToMs);
      windows.push(...HistoryEngine.yearWindows(requestFromMs, headEnd));
    }
    // Only refresh the tail when the requested window actually reaches the tail zone.
    const tailStart = Math.max(manifestLatestMs - tailMs, manifestEarliestMs);
    if (requestToMs >= tailStart) {
      const headReachesTail = windows.length > 0 && Date.parse(windows[windows.length - 1]!.toIso) >= tailStart;
      if (!headReachesTail) {
        windows.push(...HistoryEngine.yearWindows(Math.max(tailStart, requestFromMs), requestToMs));
      }
    }
    return windows.filter((window) => Date.parse(window.toIso) >= Date.parse(window.fromIso));
  }

  /** Persist all consumption for a meter: backfill from `since` (or the earliest tariff agreement, or the configured backfill window) and refresh the last 48 hours. */
  async syncConsumption(meter: MeterDescriptor, since?: string): Promise<SyncOutcome> {
    const key = this.consumptionKey(meter);
    const fromMs = since
      ? Date.parse(since)
      : (this.earliestAgreementStart(meter) ?? this.defaultBackfillStart()).toMillis();
    return this.fetchConsumptionSpan(meter, key, fromMs, DateTime.utc().toMillis());
  }

  async ensureConsumption(
    meter: MeterDescriptor,
    range: Pick<PeriodRange, "from" | "to">
  ): Promise<{ provenance: ConsumptionProvenance; records: ConsumptionRecord[] }> {
    const key = this.consumptionKey(meter);
    const fromMs = Date.parse(range.from);
    const toMs = Date.parse(range.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      throw new Error("What-if period boundaries must be valid ISO timestamps");
    }
    const expected = meter.fuel === "electricity" ? Math.ceil((toMs - fromMs) / (30 * 60 * 1000)) : null;

    const evaluate = async (fetchedPages: number) => {
      const stored = await this.store.readConsumption(key, fromMs, toMs);
      const manifest = stored.manifest;
      const covered =
        Boolean(manifest?.earliest) &&
        Date.parse(manifest!.earliest!) <= fromMs &&
        // the latest interval's start OR end reaches the requested end
        Date.parse(manifest!.latest!) + 30 * 60 * 1000 >= toMs;
      const dense = expected === null || countUniqueIntervals(stored.records) >= expected * 0.9;
      return {
        provenance: {
          source: "local_history_store" as const,
          records: countUniqueIntervals(stored.records),
          complete: covered && dense,
          expected_intervals: expected,
          api_pages: fetchedPages
        },
        records: stored.records
      };
    };

    let result = await evaluate(0);
    if (result.provenance.complete) return result;
    if (await this.hasRecentHole("consumption", key, range.from, range.to)) return result;

    const manifest = await this.store.manifest("consumption", key);
    const spans = HistoryEngine.coverageSpanWindows(
      manifest?.earliest ? Date.parse(manifest.earliest) : null,
      manifest?.latest ? Date.parse(manifest.latest) : null,
      fromMs,
      toMs,
      CONSUMPTION_TAIL_MS
    );
    let fetchedPages = 0;
    for (const span of spans) {
      fetchedPages += await this.fetchConsumptionWindow(meter, key, span.fromIso, span.toIso);
    }
    result = await evaluate(fetchedPages);
    if (!result.provenance.complete) {
      await this.recordHole("consumption", key, range.from, range.to);
    }
    return result;
  }

  async ensureRates(
    target: Pick<TariffTarget, "product_code" | "tariff_code" | "fuel">,
    kind: "unit" | "standing",
    range: Pick<PeriodRange, "from" | "to">
  ): Promise<{ provenance: RatesProvenance; records: RateRecord[] }> {
    const key = HistoryEngine.ratesKey(target, kind);
    const fromMs = Date.parse(range.from);
    const toMs = Date.parse(range.to);

    const evaluate = async (fetchedPages: number) => {
      const stored = await this.store.readRates(key, fromMs, toMs);
      const manifest = stored.manifest;
      // Rates are published continuously (day-ahead); a window reaching the
      // present always tries a small tail refresh unless recently attempted.
      const covered =
        Boolean(manifest?.earliest) &&
        Date.parse(manifest!.earliest!) <= fromMs &&
        (Date.parse(manifest!.latest!) >= toMs - 36 * 60 * 60 * 1000 || toMs < Date.parse(manifest!.latest!));
      return {
        provenance: { records: stored.records.length, complete: covered, api_pages: fetchedPages },
        records: stored.records
      };
    };

    let result = await evaluate(0);
    if (result.provenance.complete) return result;
    if (await this.hasRecentHole("rates", key, range.from, range.to)) return result;

    const manifest = await this.store.manifest("rates", key);
    const spans = HistoryEngine.coverageSpanWindows(
      manifest?.earliest ? Date.parse(manifest.earliest) : null,
      manifest?.latest ? Date.parse(manifest.latest) : null,
      fromMs,
      toMs,
      RATES_TAIL_MS
    );
    let fetchedPages = 0;
    for (const span of spans) {
      const fetched = await this.runtime.rest.getTariffRates(
        { fuel: target.fuel, product_code: target.product_code, tariff_code: target.tariff_code },
        kind,
        span.fromIso,
        span.toIso
      );
      fetchedPages += fetched.pages_fetched;
      await this.store.writeRates(key, fetched.results);
    }
    result = await evaluate(fetchedPages);
    if (!result.provenance.complete) {
      await this.recordHole("rates", key, range.from, range.to);
    }
    return result;
  }

  /**
   * Replay stored consumption across the supplied tariffs using the local
   * history store, transparently filling coverage gaps once.
   */
  async whatIfUsage(input: {
    meter?: MeterDescriptor;
    meter_selector?: MeterSelector;
    range: PeriodRange;
    scenarios: Array<{ tariff_code: string; product_code?: string; label?: string; fuel?: Fuel }>;
    include_standing_charges: boolean;
    gas_unit?: GasConsumptionUnit;
  }): Promise<WhatIfResult> {
    const meter = input.meter ?? (await this.runtime.rest.selectMeter(input.meter_selector ?? {}));
    if (meter.direction === "export") {
      throw new Error(
        "What-if replay supports import meters only; export readings represent tariff revenue, not usage cost"
      );
    }

    const consumption = await this.ensureConsumption(meter, input.range);
    const normalized = normalizeConsumption(
      consumption.records,
      meter.fuel,
      input.gas_unit ?? this.config.gasConsumptionUnit,
      this.config.gasM3ToKwhFactor
    );
    if (normalized.unit !== "kWh") {
      throw new Error("Cost estimation needs consumption in kWh; set gas_unit to kwh or m3 for gas meters");
    }

    const warnings: string[] = [];
    if (consumption.provenance.records === 0) {
      warnings.push("No metered consumption found for this window; totals are zero because there is nothing to replay.");
    } else if (!consumption.provenance.complete) {
      warnings.push(
        "Metered history for this window is incomplete; the replay covers the intervals that exist locally and at Octopus."
      );
    }

    const scenarios: WhatIfScenario[] = [];
    let rate_pages = 0;
    for (const scenario of input.scenarios) {
      const fuel = scenario.fuel ?? meter.fuel;
      if (fuel !== meter.fuel) {
        throw new Error(`Tariff ${scenario.tariff_code} is a ${fuel} tariff but the selected meter is ${meter.fuel}`);
      }
      const target: TariffTarget = {
        fuel,
        tariff_code: scenario.tariff_code.toUpperCase(),
        product_code: scenario.product_code?.toUpperCase() ?? productCodeFromTariff(scenario.tariff_code),
        ...(scenario.label ? { label: scenario.label } : {})
      };
      const unit = await this.ensureRates(target, "unit", input.range);
      const standing = input.include_standing_charges
        ? await this.ensureRates(target, "standing", input.range)
        : null;
      rate_pages += unit.provenance.api_pages + (standing?.provenance.api_pages ?? 0);
      const estimate = estimateCost(
        normalized.records,
        unit.records,
        standing?.records ?? [],
        target,
        this.config.timezone,
        input.range
      );
      scenarios.push({
        label: estimate.label,
        tariff_code: target.tariff_code,
        product_code: target.product_code,
        fuel,
        estimate,
        rate_provenance: { unit: unit.provenance, standing: standing ? standing.provenance : null }
      });
    }

    const sorted = [...scenarios].sort((a, b) => a.estimate.total_cost_pence - b.estimate.total_cost_pence);
    const cheapest = sorted[0]
      ? { label: sorted[0].estimate.label, tariff_code: sorted[0].tariff_code, total_cost_gbp: sorted[0].estimate.total_cost_gbp }
      : null;

    return {
      meter,
      requested_period: input.range,
      data_source: "local_history_store",
      consumption: consumption.provenance,
      scenarios,
      cheapest,
      api_requests: { consumption_pages: consumption.provenance.api_pages, rate_pages },
      warnings
    };
  }

  /** Sync every single-register tariff pair (unit + standing) so past tariffs stay replayable offline. */
  async syncTariff(
    target: { tariff_code: string; product_code?: string; fuel?: Fuel },
    since?: string
  ): Promise<SyncOutcome[]> {
    const product_code = target.product_code?.toUpperCase() ?? productCodeFromTariff(target.tariff_code);
    const tariff_code = target.tariff_code.toUpperCase();
    const resolvedTarget = { fuel: target.fuel ?? "electricity", product_code, tariff_code };
    const fromMs = since
      ? Date.parse(since)
      : DateTime.utc().minus({ years: Math.max(0, this.config.historyBackfillYears ?? 3) }).toMillis();
    const outcomes: SyncOutcome[] = [];
    for (const kind of ["unit", "standing"] as const) {
      const key = HistoryEngine.ratesKey(resolvedTarget, kind);
      const outcome = await this.fetchRatesSpan(resolvedTarget, kind, key, fromMs, DateTime.utc().plus({ hours: 36 }).toMillis());
      outcomes.push({
        key,
        kind: "rates",
        tariff_code,
        product_code,
        rate_kind: kind,
        added: outcome.added,
        records: outcome.records,
        earliest: outcome.earliest,
        latest: outcome.latest,
        api_pages: outcome.pages
      });
    }
    return outcomes;
  }

  private async fetchConsumptionSpan(
    meter: MeterDescriptor,
    key: string,
    fromMs: number,
    toMs: number
  ): Promise<SyncOutcome> {
    const manifest = await this.store.manifest("consumption", key);
    const spans = HistoryEngine.coverageSpanWindows(
      manifest?.earliest ? Date.parse(manifest.earliest) : null,
      manifest?.latest ? Date.parse(manifest.latest) : null,
      fromMs,
      toMs,
      CONSUMPTION_TAIL_MS
    );
    let pages = 0;
    let written: { added: number; records: number; earliest: string | null; latest: string | null } | null = null;
    for (const span of spans) {
      const fetched = await this.runtime.rest.getConsumption({
        fuel: meter.fuel,
        direction: meter.direction,
        meter_point: meter.meter_point,
        serial_number: meter.serial_number,
        period_from: span.fromIso,
        period_to: span.toIso,
        order_by: "period"
      });
      pages += fetched.data.pages_fetched;
      written = await this.store.writeConsumption(key, fetched.data.results);
    }
    if (spans.length === 0) {
      const current = await this.store.manifest("consumption", key);
      return {
        key,
        kind: "consumption",
        meter_point: meter.meter_point,
        serial_number: meter.serial_number,
        added: 0,
        records: current ? Object.values(current.shards).reduce((sum, count) => sum + count, 0) : 0,
        earliest: current?.earliest ?? null,
        latest: current?.latest ?? null,
        api_pages: 0
      };
    }
    if (!written) {
      throw new Error("Expected stored consumption outcomes after fetching spans");
    }
    return {
      key,
      kind: "consumption",
      meter_point: meter.meter_point,
      serial_number: meter.serial_number,
      added: written.added,
      records: written.records,
      earliest: written.earliest,
      latest: written.latest,
      api_pages: pages
    };
  }

  private async fetchConsumptionWindow(
    meter: MeterDescriptor,
    key: string,
    fromIso: string,
    toIso: string
  ): Promise<number> {
    const fetched = await this.runtime.rest.getConsumption({
      fuel: meter.fuel,
      direction: meter.direction,
      meter_point: meter.meter_point,
      serial_number: meter.serial_number,
      period_from: fromIso,
      period_to: toIso,
      order_by: "period"
    });
    await this.store.writeConsumption(key, fetched.data.results);
    return fetched.data.pages_fetched;
  }

  private async fetchRatesSpan(
    target: { product_code: string; tariff_code: string; fuel: Fuel },
    kind: "unit" | "standing",
    key: string,
    fromMs: number,
    toMs: number
  ): Promise<{ added: number; records: number; earliest: string | null; latest: string | null; pages: number }> {
    const manifest = await this.store.manifest("rates", key);
    const spans = HistoryEngine.coverageSpanWindows(
      manifest?.earliest ? Date.parse(manifest.earliest) : null,
      manifest?.latest ? Date.parse(manifest.latest) : null,
      fromMs,
      toMs,
      RATES_TAIL_MS
    );
    let pages = 0;
    let written: { added: number; records: number; earliest: string | null; latest: string | null } | null = null;
    for (const span of spans) {
      const fetched = await this.runtime.rest.getTariffRates(
        { fuel: target.fuel, product_code: target.product_code, tariff_code: target.tariff_code },
        kind,
        span.fromIso,
        span.toIso
      );
      pages += fetched.pages_fetched;
      written = await this.store.writeRates(key, fetched.results);
    }
    if (!written) {
      const current = await this.store.manifest("rates", key);
      return {
        added: 0,
        records: current ? Object.values(current.shards).reduce((sum, count) => sum + count, 0) : 0,
        earliest: current?.earliest ?? null,
        latest: current?.latest ?? null,
        pages: 0
      };
    }
    return { ...written, pages };
  }

  private async hasRecentHole(
    type: "consumption" | "rates",
    key: string,
    fromIso: string,
    toIso: string
  ): Promise<boolean> {
    const holes = await this.store.holes(type, key);
    const attempted = holes[`${fromIso}..${toIso}`];
    return (
      typeof attempted === "number" &&
      attempted > DateTime.utc().minus({ hours: HOLE_RETRY_TTL_HOURS }).toMillis()
    );
  }

  private async recordHole(
    type: "consumption" | "rates",
    key: string,
    fromIso: string,
    toIso: string
  ): Promise<void> {
    await this.store.recordHole(type, key, fromIso, toIso, DateTime.utc().toMillis());
  }
}

function countUniqueIntervals(records: ConsumptionRecord[]): number {
  const seen = new Set<string>();
  for (const record of records) seen.add(record.interval_start);
  return seen.size;
}
