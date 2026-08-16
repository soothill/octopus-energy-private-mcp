import { DateTime, Interval } from "luxon";
import type {
  ConsumptionRecord,
  CostEstimate,
  Fuel,
  GasConsumptionUnit,
  PeriodRange,
  RateRecord,
  TariffTarget,
  UsageAnalysis,
  UsageBucket
} from "./types.js";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export interface NormalizedConsumption {
  records: ConsumptionRecord[];
  unit: "kWh" | "m3" | "unknown";
  sourceUnit: "kWh" | "m3" | "unknown";
  conversionFactor: number | null;
  warnings: string[];
}

export function normalizeConsumption(
  records: ConsumptionRecord[],
  fuel: Fuel,
  gasUnit: GasConsumptionUnit,
  gasM3ToKwhFactor: number
): NormalizedConsumption {
  if (fuel === "electricity") {
    return { records, unit: "kWh", sourceUnit: "kWh", conversionFactor: null, warnings: [] };
  }
  if (gasUnit === "m3") {
    return {
      records: records.map((record) => ({
        ...record,
        consumption: record.consumption * gasM3ToKwhFactor
      })),
      unit: "kWh",
      sourceUnit: "m3",
      conversionFactor: gasM3ToKwhFactor,
      warnings: [
        `Gas volume was converted with the configured ${gasM3ToKwhFactor} kWh/m3 estimate; bills use the meter-specific calorific-value formula.`
      ]
    };
  }
  if (gasUnit === "kwh") {
    return { records, unit: "kWh", sourceUnit: "kWh", conversionFactor: null, warnings: [] };
  }
  return {
    records,
    unit: "unknown",
    sourceUnit: "unknown",
    conversionFactor: null,
    warnings: [
      "Gas consumption units cannot be inferred from the REST response. Set OCTOPUS_GAS_CONSUMPTION_UNIT or pass gas_unit as kwh or m3."
    ]
  };
}

function round(value: number, places = 6): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function roundHalfEven(value: number, places = 2): number {
  const factor = 10 ** places;
  const scaled = value * factor;
  const lower = Math.floor(scaled);
  const fraction = scaled - lower;
  if (Math.abs(fraction - 0.5) < 1e-9) {
    return (lower % 2 === 0 ? lower : lower + 1) / factor;
  }
  return Math.round(scaled) / factor;
}

function deduplicateConsumption(records: ConsumptionRecord[]): {
  records: ConsumptionRecord[];
  duplicateCount: number;
} {
  const unique = new Map<string, ConsumptionRecord>();
  let duplicateCount = 0;
  for (const record of records) {
    if (unique.has(record.interval_start)) duplicateCount += 1;
    unique.set(record.interval_start, record);
  }
  return {
    records: [...unique.values()].sort(
      (a, b) => Date.parse(a.interval_start) - Date.parse(b.interval_start)
    ),
    duplicateCount
  };
}

function aggregate(records: ConsumptionRecord[], key: (date: DateTime) => string, timezone: string): UsageBucket[] {
  const totals = new Map<string, UsageBucket>();
  for (const record of records) {
    const date = DateTime.fromISO(record.interval_start, { setZone: true }).setZone(timezone);
    const period = key(date);
    const bucket = totals.get(period) ?? { period, consumption: 0, intervals: 0 };
    bucket.consumption += record.consumption;
    bucket.intervals += 1;
    totals.set(period, bucket);
  }
  return [...totals.values()]
    .sort((a, b) => a.period.localeCompare(b.period))
    .map((bucket) => ({ ...bucket, consumption: round(bucket.consumption) }));
}

export function analyseUsage(
  rawRecords: ConsumptionRecord[],
  fuel: Fuel,
  timezone: string,
  gasUnit: GasConsumptionUnit,
  gasM3ToKwhFactor: number,
  requestedRange?: Pick<PeriodRange, "from" | "to">
): UsageAnalysis {
  const deduplicated = deduplicateConsumption(rawRecords);
  const normalized = normalizeConsumption(deduplicated.records, fuel, gasUnit, gasM3ToKwhFactor);
  const records = normalized.records;
  const total = records.reduce((sum, record) => sum + record.consumption, 0);
  const first = records[0];
  const last = records.at(-1);
  const periodFrom = first?.interval_start ?? null;
  const periodTo = last?.interval_end ?? null;
  const daysCovered = periodFrom && periodTo
    ? Math.max(0, Interval.fromDateTimes(DateTime.fromISO(periodFrom), DateTime.fromISO(periodTo)).length("days"))
    : 0;
  const expectedDays = requestedRange
    ? Math.max(0, DateTime.fromISO(requestedRange.to).diff(DateTime.fromISO(requestedRange.from), "days").days)
    : daysCovered;
  const expected = expectedDays > 0 ? Math.max(1, Math.round(expectedDays * 48)) : 0;
  const gaps: Array<{ after: string; before: string; minutes: number }> = [];
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1]!;
    const current = records[index]!;
    const gapMinutes = DateTime.fromISO(current.interval_start).diff(
      DateTime.fromISO(previous.interval_end),
      "minutes"
    ).minutes;
    if (gapMinutes > 1) {
      gaps.push({ after: previous.interval_end, before: current.interval_start, minutes: round(gapMinutes, 2) });
    }
  }

  const hourTotals = new Map<number, { total: number; intervals: number }>();
  const weekdayTotals = new Map<number, { total: number; intervals: number }>();
  for (const record of records) {
    const date = DateTime.fromISO(record.interval_start, { setZone: true }).setZone(timezone);
    const hour = hourTotals.get(date.hour) ?? { total: 0, intervals: 0 };
    hour.total += record.consumption;
    hour.intervals += 1;
    hourTotals.set(date.hour, hour);
    const weekday = weekdayTotals.get(date.weekday) ?? { total: 0, intervals: 0 };
    weekday.total += record.consumption;
    weekday.intervals += 1;
    weekdayTotals.set(date.weekday, weekday);
  }

  const byHour = Array.from({ length: 24 }, (_, hour) => {
    const value = hourTotals.get(hour) ?? { total: 0, intervals: 0 };
    return {
      hour,
      total: round(value.total),
      average: value.intervals ? round(value.total / value.intervals) : 0,
      intervals: value.intervals
    };
  });
  const byWeekday = Array.from({ length: 7 }, (_, offset) => {
    const weekday = offset + 1;
    const value = weekdayTotals.get(weekday) ?? { total: 0, intervals: 0 };
    return {
      weekday: WEEKDAYS[offset]!,
      total: round(value.total),
      average: value.intervals ? round(value.total / value.intervals) : 0,
      intervals: value.intervals
    };
  });

  return {
    unit: normalized.unit,
    source_unit: normalized.sourceUnit,
    conversion_factor: normalized.conversionFactor,
    total: round(total),
    interval_count: records.length,
    average_per_interval: records.length ? round(total / records.length) : 0,
    average_per_day: daysCovered ? round(total / daysCovered) : 0,
    period_from: periodFrom,
    period_to: periodTo,
    days_covered: round(daysCovered, 3),
    peak_intervals: [...records].sort((a, b) => b.consumption - a.consumption).slice(0, 10),
    lowest_non_zero_intervals: [...records]
      .filter((record) => record.consumption > 0)
      .sort((a, b) => a.consumption - b.consumption)
      .slice(0, 10),
    by_day: aggregate(records, (date) => date.toISODate()!, timezone),
    by_month: aggregate(records, (date) => date.toFormat("yyyy-LL"), timezone),
    by_hour_of_day: byHour,
    by_weekday: byWeekday,
    data_quality: {
      expected_half_hour_intervals: expected,
      observed_unique_intervals: records.length,
      coverage_percent: expected ? round(Math.min(100, (records.length / expected) * 100), 2) : 0,
      duplicate_intervals: deduplicated.duplicateCount,
      gaps: gaps.slice(0, 100)
    },
    warnings: [
      ...normalized.warnings,
      ...(gaps.length > 100 ? [`${gaps.length - 100} additional gaps were omitted from the response.`] : [])
    ]
  };
}

export function compareAnalyses(current: UsageAnalysis, comparison: UsageAnalysis): Record<string, unknown> {
  const change = current.total - comparison.total;
  return {
    current,
    comparison,
    difference: round(change),
    percent_change: comparison.total === 0 ? null : round((change / comparison.total) * 100, 2),
    interpretation:
      comparison.total === 0
        ? "A percentage change cannot be calculated because comparison usage is zero."
        : change > 0
          ? `Usage increased by ${round((change / comparison.total) * 100, 2)}%.`
          : change < 0
            ? `Usage decreased by ${Math.abs(round((change / comparison.total) * 100, 2))}%.`
            : "Usage was unchanged."
  };
}

function matchingRate(rates: RateRecord[], instant: number): RateRecord | undefined {
  return rates.find((rate) => {
    const start = Date.parse(rate.valid_from);
    const end = rate.valid_to ? Date.parse(rate.valid_to) : Number.POSITIVE_INFINITY;
    return start <= instant && instant < end;
  });
}

export function estimateCost(
  consumption: ConsumptionRecord[],
  unitRates: RateRecord[],
  standingCharges: RateRecord[],
  target: TariffTarget,
  timezone: string,
  requestedRange?: Pick<PeriodRange, "from" | "to">
): CostEstimate {
  const deduplicated = deduplicateConsumption(consumption);
  let unitCost = 0;
  let consumptionKwh = 0;
  let pricedIntervals = 0;
  let unpricedIntervals = 0;
  const days = new Set<string>();
  for (const record of deduplicated.records) {
    const instant = Date.parse(record.interval_start);
    const rate = matchingRate(unitRates, instant);
    consumptionKwh += record.consumption;
    const day = DateTime.fromISO(record.interval_start, { setZone: true }).setZone(timezone).toISODate();
    if (day) days.add(day);
    if (rate) {
      unitCost += roundHalfEven(record.consumption, 2) * rate.value_inc_vat;
      pricedIntervals += 1;
    } else {
      unpricedIntervals += 1;
    }
  }
  if (requestedRange) {
    const end = DateTime.fromISO(requestedRange.to, { setZone: true }).setZone(timezone);
    let cursor = DateTime.fromISO(requestedRange.from, { setZone: true }).setZone(timezone).startOf("day");
    while (cursor.toMillis() < end.toMillis()) {
      const day = cursor.toISODate();
      if (day) days.add(day);
      cursor = cursor.plus({ days: 1 });
    }
  }
  let standingCost = 0;
  let pricedDays = 0;
  for (const day of days) {
    const midday = DateTime.fromISO(day, { zone: timezone }).plus({ hours: 12 }).toMillis();
    const rate = matchingRate(standingCharges, midday);
    if (rate) {
      standingCost += rate.value_inc_vat;
      pricedDays += 1;
    }
  }
  const total = unitCost + standingCost;
  const warnings: string[] = [];
  if (deduplicated.duplicateCount) {
    warnings.push(
      `${deduplicated.duplicateCount} duplicate consumption ${deduplicated.duplicateCount === 1 ? "interval was" : "intervals were"} removed before pricing.`
    );
  }
  if (unpricedIntervals) warnings.push(`${unpricedIntervals} consumption intervals had no matching unit rate.`);
  if (pricedDays < days.size) warnings.push(`${days.size - pricedDays} days had no matching standing charge.`);
  warnings.push("This is an estimate from consumption and published VAT-inclusive rates, not a bill calculation.");
  warnings.push("Each interval is rounded half-to-even to 0.01 kWh before applying its unit rate, following Octopus REST guidance.");
  return {
    label: target.label ?? target.tariff_code,
    product_code: target.product_code,
    tariff_code: target.tariff_code,
    fuel: target.fuel,
    consumption_kwh: round(consumptionKwh),
    unit_cost_pence: round(unitCost, 3),
    standing_charge_pence: round(standingCost, 3),
    total_cost_pence: round(total, 3),
    total_cost_gbp: round(total / 100, 2),
    priced_intervals: pricedIntervals,
    unpriced_intervals: unpricedIntervals,
    standing_charge_days: pricedDays,
    rate_coverage_percent: deduplicated.records.length
      ? round((pricedIntervals / deduplicated.records.length) * 100, 2)
      : 0,
    warnings
  };
}

export interface CheapestWindow {
  start: string;
  end: string;
  slots: number;
  average_pence_per_kwh: number;
  total_slot_prices_pence: number;
}

export function findCheapestWindows(
  rates: RateRecord[],
  slots: number,
  limit: number
): CheapestWindow[] {
  if (slots < 1) throw new Error("slots must be at least 1");
  const ordered = [...rates].sort((a, b) => Date.parse(a.valid_from) - Date.parse(b.valid_from));
  for (const rate of ordered) {
    const start = Date.parse(rate.valid_from);
    const end = rate.valid_to ? Date.parse(rate.valid_to) : Number.NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error("Cheapest windows require rates with valid start and end timestamps");
    }
    if (end - start !== 30 * 60 * 1000) {
      throw new Error("Cheapest windows require rate intervals that are exactly 30 minutes long");
    }
  }
  const windows: CheapestWindow[] = [];
  for (let index = 0; index <= ordered.length - slots; index += 1) {
    const slice = ordered.slice(index, index + slots);
    let contiguous = true;
    for (let offset = 1; offset < slice.length; offset += 1) {
      if (Date.parse(slice[offset - 1]!.valid_to!) !== Date.parse(slice[offset]!.valid_from)) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;
    const total = slice.reduce((sum, rate) => sum + rate.value_inc_vat, 0);
    windows.push({
      start: slice[0]!.valid_from,
      end: slice.at(-1)!.valid_to!,
      slots,
      average_pence_per_kwh: round(total / slots, 4),
      total_slot_prices_pence: round(total, 4)
    });
  }
  return windows
    .sort((a, b) => a.average_pence_per_kwh - b.average_pence_per_kwh || a.start.localeCompare(b.start))
    .slice(0, limit);
}
