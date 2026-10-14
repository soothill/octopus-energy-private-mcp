import { DateTime } from "luxon";
import type { PollerConfig } from "./config.js";
import { InfluxWriter, type Point } from "./influx.js";
import { OctopusPollerClient, regionLetterFromTariff, type MeterTarget, type RateRecord } from "./octopus.js";
import { IntelligentGraphqlClient, type IntelligentDevice } from "./intelligent.js";
import { batteryPlanPoints, planBatteryDay } from "./planner.js";

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

/** Octopus bills half-hourly consumption rounded half-to-even to 0.01 kWh. */
export function roundHalfToEven(value: number): number {
  const scaled = value * 100;
  const floor = Math.floor(scaled);
  const remainder = scaled - floor;
  let rounded: number;
  if (Math.abs(remainder - 0.5) < 1e-9) {
    rounded = floor % 2 === 0 ? floor : floor + 1;
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / 100;
}

function rateAt(rates: RateRecord[], at: number): RateRecord | null {
  return rates.find((rate) => {
    const from = Date.parse(rate.valid_from);
    const to = rate.valid_to ? Date.parse(rate.valid_to) : Number.POSITIVE_INFINITY;
    return from <= at && at < to;
  }) ?? null;
}

function toUnixSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/** Expand rate blocks (any duration) into half-hourly records covering [fromMs, toMs). */
function expandToHalfHours(rates: RateRecord[], fromMs: number, toMs: number): RateRecord[] {
  const slotMs = 1_800_000;
  const start = Math.floor(fromMs / slotMs) * slotMs;
  const slots: RateRecord[] = [];
  for (let at = start; at < toMs; at += slotMs) {
    const rate = rateAt(rates, at);
    if (!rate) continue;
    slots.push({
      valid_from: new Date(at).toISOString(),
      valid_to: new Date(at + slotMs).toISOString(),
      value_inc_vat: rate.value_inc_vat,
      value_exc_vat: rate.value_exc_vat
    });
  }
  return slots;
}

function ratePoints(
  prefix: string,
  site: string,
  direction: string,
  tariffCode: string,
  rates: RateRecord[],
  source: "tariff" | "intelligent" | "market" = "tariff"
): Point[] {
  // Rates with valid_to=null are open-ended flat rates (e.g. Outgoing Octopus) — keep them.
  return rates.map((rate) => ({
    measurement: `${prefix}price`,
    tags: { site, direction, tariff_code: tariffCode, source },
    fields: { value_inc_vat: rate.value_inc_vat, value_exc_vat: rate.value_exc_vat },
    timestamp: toUnixSeconds(rate.valid_from)
  }));
}

interface HalfHourPair {
  at: number;
  import_p: number;
  export_p: number;
  spread_p: number;
}

function pairHalfHours(importRates: RateRecord[], exportRates: RateRecord[], from: number, to: number): HalfHourPair[] {
  const pairs: HalfHourPair[] = [];
  for (const rate of importRates) {
    if (!rate.valid_to) continue;
    const at = Date.parse(rate.valid_from);
    if (at < from || at >= to) continue;
    const exportRate = rateAt(exportRates, at);
    if (!exportRate) continue;
    pairs.push({
      at,
      import_p: rate.value_inc_vat,
      export_p: exportRate.value_inc_vat,
      spread_p: Number((exportRate.value_inc_vat - rate.value_inc_vat).toFixed(4))
    });
  }
  return pairs.sort((a, b) => a.at - b.at);
}

function batterySignalPoints(prefix: string, site: string, pairs: HalfHourPair[]): Point[] {
  return pairs.map((pair) => ({
    measurement: `${prefix}battery_signal`,
    tags: { site, action: pair.spread_p > 0 ? "export" : "import" },
    fields: {
      import_pence: pair.import_p,
      export_pence: pair.export_p,
      spread_pence: pair.spread_p
    },
    timestamp: pair.at / 1000
  }));
}

function batteryPlanPoint(prefix: string, site: string, pairs: HalfHourPair[], timezone: string): Point | null {
  if (pairs.length === 0) return null;
  const positive = pairs.filter((pair) => pair.spread_p > 0).sort((a, b) => b.spread_p - a.spread_p);
  const cheapest = [...pairs].sort((a, b) => a.import_p - b.import_p).slice(0, 4);
  const day = DateTime.fromSeconds(pairs[0]!.at / 1000, { zone: timezone }).toISODate() ?? "unknown";
  return {
    measurement: `${prefix}battery_plan`,
    tags: { site, day },
    fields: {
      half_hours_priced: pairs.length,
      profitable_export_half_hours: positive.length,
      potential_margin_p_per_kwh: Number(positive.reduce((total, pair) => total + pair.spread_p, 0).toFixed(2)),
      best_export_1_unix: (positive[0]?.at ?? 0) / 1000,
      best_export_2_unix: (positive[1]?.at ?? 0) / 1000,
      best_export_3_unix: (positive[2]?.at ?? 0) / 1000,
      best_export_4_unix: (positive[3]?.at ?? 0) / 1000,
      cheapest_import_1_unix: (cheapest[0]?.at ?? 0) / 1000,
      cheapest_import_2_unix: (cheapest[1]?.at ?? 0) / 1000,
      cheapest_import_3_unix: (cheapest[2]?.at ?? 0) / 1000,
      cheapest_import_4_unix: (cheapest[3]?.at ?? 0) / 1000,
      min_import_pence: Math.min(...pairs.map((pair) => pair.import_p)),
      max_export_pence: Math.max(...pairs.map((pair) => pair.export_p))
    },
    timestamp: Math.floor(Date.now() / 1000)
  };
}

export class SitePoller {
  private targets: MeterTarget[] | null = null;
  private lastConsumptionSuccess: Date | null = null;
  private intelligentClient: IntelligentGraphqlClient | null = null;
  private intelligentDevices: IntelligentDevice[] | null = null;
  private iogRates: { day: RateRecord[]; night: RateRecord[]; fetchedAt: number } | null = null;

  constructor(
    private readonly config: PollerConfig,
    site: PollerConfig["sites"][number],
    private readonly influx: InfluxWriter
  ) {
    this.site = site;
    this.client = new OctopusPollerClient(site, {
      timeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
      minRequestIntervalMs: config.minRequestIntervalMs
    });
  }

  private readonly site: PollerConfig["sites"][number];
  private readonly client: OctopusPollerClient;

  private async targetsFresh(): Promise<{ importTarget: MeterTarget; exportTarget: MeterTarget | null }> {
    if (!this.targets) this.targets = await this.client.discoverTargets();
    const importTarget = this.targets.find((target) => target.direction === "import");
    const exportTarget = this.targets.find((target) => target.direction === "export") ?? null;
    if (!importTarget) throw new Error(`No import electricity meter found for site ${this.site.name}`);
    return { importTarget, exportTarget };
  }

  /**
   * Intelligent Octopus tariffs publish no half-hourly rates; the off-peak window
   * (23:30–05:30 local) bills at the night rate and everything else at the day rate.
   * Synthesise half-hourly RateRecords so price/cost logging matches Agile sites.
   */
  private async syntheticIogRates(importTarget: MeterTarget, from: Date, to: Date): Promise<RateRecord[]> {
    if (!this.iogRates || Date.now() - this.iogRates.fetchedAt > 12 * 3_600_000) {
      const wideFrom = new Date(Date.now() - 400 * 86_400_000);
      const wideTo = new Date(Date.now() + 10 * 86_400_000);
      const [day, night] = await Promise.all([
        this.client.getFourRateUnitRates(importTarget, "day-unit-rates", wideFrom, wideTo),
        this.client.getFourRateUnitRates(importTarget, "night-unit-rates", wideFrom, wideTo)
      ]);
      this.iogRates = { day, night, fetchedAt: Date.now() };
    }
    const { day, night } = this.iogRates;
    const slotMs = 1_800_000;
    const start = Math.floor(from.getTime() / slotMs) * slotMs;
    const slots: RateRecord[] = [];
    for (let at = start; at < to.getTime(); at += slotMs) {
      const local = DateTime.fromMillis(at, { zone: this.config.timezone });
      const minuteOfDay = local.hour * 60 + local.minute;
      const isNight = minuteOfDay >= 23 * 60 + 30 || minuteOfDay < 5 * 60 + 30;
      const rate = rateAt(isNight ? night : day, at);
      if (!rate) continue;
      slots.push({
        valid_from: new Date(at).toISOString(),
        valid_to: new Date(at + slotMs).toISOString(),
        value_inc_vat: rate.value_inc_vat,
        value_exc_vat: rate.value_exc_vat
      });
    }
    return slots;
  }

  /** Rates for a target: REST rate feed, or synthesised day/night windows for Intelligent tariffs. */
  private async effectiveRates(
    target: MeterTarget,
    from: Date,
    to: Date
  ): Promise<{ rates: RateRecord[]; source: "tariff" | "intelligent" }> {
    if (target.isIntelligent && target.direction === "import") {
      return { rates: await this.syntheticIogRates(target, from, to), source: "intelligent" };
    }
    return { rates: await this.client.getRates(target, from, to), source: "tariff" };
  }

  /** Log Intelligent Octopus dispatch windows: planned per SmartFlex device, completed per account. */
  private async pollIntelligentDispatches(): Promise<Point[]> {
    this.intelligentClient ??= new IntelligentGraphqlClient(this.site, {
      timeoutMs: this.config.requestTimeoutMs,
      maxRetries: this.config.maxRetries,
      minRequestIntervalMs: this.config.minRequestIntervalMs
    });
    if (!this.intelligentDevices) this.intelligentDevices = await this.intelligentClient.listDevices();
    const points: Point[] = [];
    let plannedCount = 0;
    for (const device of this.intelligentDevices) {
      const planned = await this.intelligentClient.plannedDispatches(device.id);
      plannedCount += planned.length;
      for (const dispatch of planned) {
        points.push({
          measurement: `${this.config.measurementPrefix}intelligent_dispatch`,
          tags: {
            site: this.site.slug,
            device_id: device.id,
            device_type: device.deviceType,
            status: "planned",
            dispatch_type: dispatch.type
          },
          fields: {
            energy_kwh: Number(dispatch.energyAddedKwh ?? 0),
            duration_minutes: Math.round((Date.parse(dispatch.end) - Date.parse(dispatch.start)) / 60_000)
          },
          timestamp: toUnixSeconds(dispatch.start)
        });
      }
    }
    const completed = await this.intelligentClient.completedDispatches();
    for (const dispatch of completed) {
      points.push({
        measurement: `${this.config.measurementPrefix}intelligent_dispatch`,
        tags: {
          site: this.site.slug,
          status: "completed",
          dispatch_type: dispatch.meta?.source ?? "unknown"
        },
        fields: {
          energy_kwh: Number(dispatch.delta ?? 0),
          duration_minutes: Math.round((Date.parse(dispatch.end) - Date.parse(dispatch.start)) / 60_000)
        },
        timestamp: toUnixSeconds(dispatch.start)
      });
    }
    log(`${this.site.name}: ${plannedCount} planned + ${completed.length} completed intelligent dispatches`);
    return points;
  }

  /**
   * Day-ahead Agile market prices for this site's region (import + export), written to
   * octopus_market_price so tariffs can be compared ("would Agile beat my current tariff?").
   * The region letter is derived from the site's own tariff code (e.g. -F Yorkshire, -B Eastern).
   */
  async pollMarketPrices(): Promise<void> {
    const { importTarget } = await this.targetsFresh();
    const region = regionLetterFromTariff(importTarget.tariff_code);
    if (!region) {
      log(`${this.site.name}: cannot derive region from ${importTarget.tariff_code}; skipping market prices`);
      return;
    }
    const now = Date.now();
    const from = new Date(now - this.config.backfillDays * 86_400_000);
    const to = new Date(now + this.config.lookaheadDays * 86_400_000);
    const jobs: Array<{ product: string; direction: "import" | "export" }> = [
      ...this.config.marketImportProducts.map((product) => ({ product, direction: "import" as const })),
      ...this.config.marketExportProducts.map((product) => ({ product, direction: "export" as const }))
    ];
    const points: Point[] = [];
    let plannerImport: RateRecord[] | null = null;
    let plannerExport: RateRecord[] | null = null;
    for (const job of jobs) {
      const tariffCode = `E-1R-${job.product}-${region}`;
      try {
        const rates = await this.client.getTariffRates(job.product, tariffCode, from, to);
        // Normalise every market tariff to half-hourly points: Agile already publishes
        // half-hours, while dual-rate tariffs (e.g. Prime Outgoing Fixed day/night) and
        // flat tariffs arrive as long blocks that would otherwise sit at block-start only.
        const halfHours = expandToHalfHours(rates, from.getTime(), to.getTime());
        if (job.direction === "import" && job.product === this.config.battery.plannerImportProduct) {
          plannerImport = halfHours;
        }
        if (job.direction === "export" && job.product === this.config.battery.plannerExportProduct) {
          plannerExport = halfHours;
        }
        points.push(
          ...ratePoints(this.config.measurementPrefix, this.site.slug, job.direction, tariffCode, halfHours, "market")
        );
        log(`${this.site.name}: ${halfHours.length} market ${job.direction} half-hours (${tariffCode}, region ${region}, from ${rates.length} rate blocks)`);
      } catch (error) {
        log(`${this.site.name}: market ${job.direction} rates failed for ${tariffCode}: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (this.config.battery.sites.includes(this.site.slug) && plannerImport && plannerExport) {
      try {
        const plan = planBatteryDay(plannerImport, plannerExport, this.config.battery, this.config.timezone);
        if (plan) {
          points.push(...batteryPlanPoints(this.config.measurementPrefix, this.site.slug, plan));
          log(
            `${this.site.name}: battery plan for ${plan.day}, expected profit £${(plan.summary.expected_profit_pence / 100).toFixed(2)} ` +
              `(cycle A ${plan.summary.cycle_a_enabled ? "on" : "off"}, evening ${plan.summary.evening_export_kwh} kWh, reserve ${plan.summary.reserve_kwh} kWh)`
          );
        }
      } catch (error) {
        log(`${this.site.name}: battery plan failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (points.length > 0) {
      points.push({
        measurement: `${this.config.measurementPrefix}poll_status`,
        tags: { site: this.site.slug, task: "market_prices" },
        fields: { ok: 1, records: points.length }
      });
      await this.influx.write(points);
    }
  }

  /** Fetch import + export rates (history and day-ahead), write prices and arbitrage signals. */
  async pollPrices(): Promise<void> {
    const { importTarget, exportTarget } = await this.targetsFresh();
    const now = Date.now();
    const from = new Date(now - this.config.backfillDays * 86_400_000);
    const to = new Date(now + this.config.lookaheadDays * 86_400_000);
    const { rates: importRates, source: importSource } = await this.effectiveRates(importTarget, from, to);
    const points: Point[] = ratePoints(
      this.config.measurementPrefix,
      this.site.slug,
      "import",
      importTarget.tariff_code,
      importRates,
      importSource
    );
    log(`${this.site.name}: ${importRates.length} import rates (${importTarget.tariff_code}${importSource === "intelligent" ? ", intelligent day/night" : ""})`);

    if (exportTarget) {
      const exportRates = await this.client.getRates(exportTarget, from, to);
      points.push(...ratePoints(this.config.measurementPrefix, this.site.slug, "export", exportTarget.tariff_code, exportRates));
      log(`${this.site.name}: ${exportRates.length} export rates (${exportTarget.tariff_code})`);
      const pairs = pairHalfHours(importRates, exportRates, now, to.getTime());
      points.push(...batterySignalPoints(this.config.measurementPrefix, this.site.slug, pairs));
      const plan = batteryPlanPoint(this.config.measurementPrefix, this.site.slug, pairs, this.config.timezone);
      if (plan) points.push(plan);
      const positive = pairs.filter((pair) => pair.spread_p > 0).length;
      log(`${this.site.name}: ${pairs.length} forward half-hours priced, ${positive} with positive export spread`);
    } else {
      log(`${this.site.name}: no export meter discovered; skipping export prices`);
    }
    if (importTarget.isIntelligent) {
      try {
        points.push(...(await this.pollIntelligentDispatches()));
      } catch (error) {
        log(`${this.site.name}: intelligent dispatch poll failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    points.push({
      measurement: `${this.config.measurementPrefix}poll_status`,
      tags: { site: this.site.slug, task: "prices" },
      fields: { ok: 1, records: points.length }
    });
    await this.influx.write(points);
  }

  /** Fetch recent consumption, write readings and matched costs/revenues. */
  async pollConsumption(): Promise<void> {
    const { importTarget, exportTarget } = await this.targetsFresh();
    const now = Date.now();
    const lookbackDays = this.lastConsumptionSuccess
      ? Math.max(2, Math.ceil((now - this.lastConsumptionSuccess.getTime()) / 86_400_000) + 1)
      : Math.max(2, this.config.backfillDays);
    const from = new Date(now - lookbackDays * 86_400_000);
    const to = new Date(now);
    const points: Point[] = [];

    const jobs: Array<{ target: MeterTarget; direction: "import" | "export" }> = [
      { target: importTarget, direction: "import" },
      ...(exportTarget ? [{ target: exportTarget, direction: "export" as const }] : [])
    ];
    for (const job of jobs) {
      const records = await this.client.getConsumption(job.target, from, to);
      const { rates } = await this.effectiveRates(job.target, from, new Date(now + 86_400_000));
      let costPence = 0;
      for (const record of records) {
        const at = Date.parse(record.interval_start);
        points.push({
          measurement: `${this.config.measurementPrefix}consumption`,
          tags: { site: this.site.slug, direction: job.direction, mpan: job.target.mpan },
          fields: { kwh: record.consumption },
          timestamp: toUnixSeconds(record.interval_start)
        });
        const rate = rateAt(rates, at);
        if (rate) {
          const pence = roundHalfToEven(record.consumption) * rate.value_inc_vat;
          costPence += pence;
          points.push({
            measurement: `${this.config.measurementPrefix}cost`,
            tags: { site: this.site.slug, direction: job.direction },
            fields: {
              kwh: record.consumption,
              rate_inc_vat: rate.value_inc_vat,
              [job.direction === "import" ? "cost_inc_vat_pence" : "revenue_inc_vat_pence"]: Number(pence.toFixed(4))
            },
            timestamp: toUnixSeconds(record.interval_start)
          });
        }
      }
      log(`${this.site.name}: ${records.length} ${job.direction} readings over ${lookbackDays}d window, ~${(costPence / 100).toFixed(2)} GBP in window`);
    }
    points.push({
      measurement: `${this.config.measurementPrefix}poll_status`,
      tags: { site: this.site.slug, task: "consumption" },
      fields: { ok: 1, records: points.length }
    });
    await this.influx.write(points);
    this.lastConsumptionSuccess = new Date();
  }
}
