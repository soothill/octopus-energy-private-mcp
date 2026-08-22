import { McpServer } from "@modelcontextprotocol/server";
import { DateTime } from "luxon";
import { z } from "zod";
import { analyseUsage, compareAnalyses, estimateCost, findCheapestWindows, normalizeConsumption } from "./analytics.js";
import { FileCache } from "./cache.js";
import { publicConfig, type ServerConfig } from "./config.js";
import { OctopusGraphQlClient } from "./graphql-client.js";
import {
  isDeviceAwareEvTariff,
  isDualRegisterTariff,
  OctopusRestClient,
  productCodeFromTariff
} from "./octopus-client.js";
import { PERIOD_ALIASES, previousEquivalentPeriod, resolvePeriod } from "./periods.js";
import { RequestRateLimiter } from "./rate-limiter.js";
import { formatUpdateNotice, notCheckedUpdateStatus, type UpdateStatus } from "./update-check.js";
import { CURRENT_VERSION } from "./version.js";
import type {
  CacheProvenance,
  ConsumptionRecord,
  EvChargeCostRecord,
  Fuel,
  GasConsumptionUnit,
  MeterDescriptor,
  PeriodRange,
  RateRecord,
  TariffTarget
} from "./types.js";

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;

function serializable(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { result: value };
}

function success(value: unknown) {
  const structuredContent = serializable(value);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected Octopus Energy MCP error";
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }]
  };
}

function safe<T>(handler: (args: T) => Promise<unknown> | unknown) {
  return async (args: T) => {
    try {
      return success(await handler(args));
    } catch (error) {
      return failure(error);
    }
  };
}

const periodFields = {
  period: z.enum(PERIOD_ALIASES).optional().describe("Named local-time period; defaults to last_30_days"),
  period_from: z.string().optional().describe("ISO date/time, or YYYY-MM-DD; requires period_to"),
  period_to: z.string().optional().describe("Exclusive ISO end, or inclusive YYYY-MM-DD; requires period_from")
};

const meterFields = {
  fuel: z.enum(["electricity", "gas"]).optional(),
  direction: z.enum(["import", "export"]).optional(),
  property_id: z.number().int().positive().optional(),
  meter_point: z.string().min(1).optional().describe("MPAN for electricity or MPRN for gas"),
  serial_number: z.string().min(1).optional()
};

const gasUnitField = z.enum(["auto", "kwh", "m3"]).optional();

type PeriodLike = {
  period?: (typeof PERIOD_ALIASES)[number];
  period_from?: string;
  period_to?: string;
};

type MeterLike = {
  fuel?: Fuel;
  direction?: "import" | "export";
  property_id?: number;
  meter_point?: string;
  serial_number?: string;
};

function targetFromInput(input: {
  fuel: Fuel;
  tariff_code: string;
  product_code?: string;
  label?: string;
}): TariffTarget {
  return {
    fuel: input.fuel,
    tariff_code: input.tariff_code.toUpperCase(),
    product_code: input.product_code?.toUpperCase() ?? productCodeFromTariff(input.tariff_code),
    ...(input.label ? { label: input.label } : {})
  };
}

function activeRate(rates: RateRecord[], at: number): RateRecord | null {
  return rates.find((rate) => {
    const from = Date.parse(rate.valid_from);
    const to = rate.valid_to ? Date.parse(rate.valid_to) : Number.POSITIVE_INFINITY;
    return from <= at && at < to;
  }) ?? null;
}

function cacheProvenance(value: CacheProvenance): CacheProvenance {
  return {
    cache_status: value.cache_status,
    stale_cache_used: value.stale_cache_used,
    ...(value.cache_age_ms === undefined ? {} : { cache_age_ms: value.cache_age_ms })
  };
}

function assertCostTariffSupported(tariffCode: string): void {
  if (isDeviceAwareEvTariff(tariffCode)) {
    throw new Error(
      "Local cost replay does not support device-aware Intelligent Octopus Go, Drive Pack, or Power Pack pricing because aggregate meter readings do not identify the EV, smart-charge allowance, or type-of-use charges. Use octopus_get_ev_charge_costs for Octopus-priced EV charging."
    );
  }
  if (isDualRegisterTariff(tariffCode)) {
    throw new Error(
      "Cost replay does not support two-register tariffs because aggregate half-hour readings do not identify day and night registers"
    );
  }
}

function assertPublishedRateViewSupported(tariffCode: string): void {
  if (isDeviceAwareEvTariff(tariffCode)) {
    throw new Error(
      "The conventional REST rate feed cannot represent separate home and EV prices for this device-aware tariff. Use octopus_get_ev_tariff_pricing for the active account-specific four-rate view."
    );
  }
}

function finiteTotal(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return null;
  return finite.reduce((total, value) => total + value, 0);
}

function summarizeEvChargeCosts(records: EvChargeCostRecord[]) {
  const consumption = finiteTotal(records.map((record) => record.totalConsumption));
  const costExclTax = finiteTotal(records.map((record) => record.totalCostExclTax));
  const costInclTax = finiteTotal(records.map((record) => record.totalCostInclTax));
  return {
    records: records.length,
    smart_charge_records: records.filter((record) => record.isSmartCharge === true).length,
    non_smart_charge_records: records.filter((record) => record.isSmartCharge === false).length,
    unclassified_records: records.filter((record) => record.isSmartCharge === null).length,
    total_consumption_kwh: consumption === null ? null : Number(consumption.toFixed(3)),
    total_cost_excl_tax_pence: costExclTax === null ? null : Number(costExclTax.toFixed(3)),
    total_cost_incl_tax_pence: costInclTax === null ? null : Number(costInclTax.toFixed(3)),
    total_cost_incl_tax_gbp: costInclTax === null ? null : Number((costInclTax / 100).toFixed(2))
  };
}

function evChargeDateRange(range: PeriodRange, timezone: string) {
  const start = DateTime.fromISO(range.from, { setZone: true }).setZone(timezone);
  const inclusiveEnd = DateTime.fromISO(range.to, { setZone: true }).setZone(timezone).minus({ milliseconds: 1 });
  const startDate = start.toISODate();
  const reportDate = inclusiveEnd.toISODate();
  if (!start.isValid || !inclusiveEnd.isValid || !startDate || !reportDate) {
    throw new Error("Could not convert the requested period into Octopus EV charge dates");
  }
  return { start_date: startDate, report_date: reportDate };
}

function redactAccountAddresses(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const account = structuredClone(value as Record<string, unknown>);
  const properties = account.properties;
  if (!Array.isArray(properties)) return account;
  for (const property of properties) {
    if (!property || typeof property !== "object") continue;
    for (const key of ["address_line_1", "address_line_2", "address_line_3", "town", "county", "postcode"]) {
      delete (property as Record<string, unknown>)[key];
    }
  }
  return account;
}

export interface ServerDependencies {
  cache?: FileCache;
  limiter?: RequestRateLimiter;
  rest?: OctopusRestClient;
  graphql?: OctopusGraphQlClient;
  updateStatus?: UpdateStatus;
}

export function createServer(config: ServerConfig, dependencies: ServerDependencies = {}): McpServer {
  const cache = dependencies.cache ?? new FileCache(config.cacheDir, config.cacheEnabled);
  const limiter = dependencies.limiter ?? new RequestRateLimiter(config.requestsPerMinute, config.minRequestIntervalMs);
  const rest = dependencies.rest ?? new OctopusRestClient(config, cache, limiter);
  const graphql = dependencies.graphql ?? new OctopusGraphQlClient(config, cache, limiter);
  const updateStatus = dependencies.updateStatus ?? notCheckedUpdateStatus(CURRENT_VERSION);
  const updateNotice = formatUpdateNotice(updateStatus);
  const server = new McpServer(
    { name: "octopus-energy-private-mcp", version: CURRENT_VERSION },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions:
        "Privacy-first, read-only Octopus Energy access. Start with octopus_connection_status and octopus_discover_meters. Prefer named periods and local analysis tools; use exact tariff codes for conventional costs, octopus_get_ev_tariff_pricing for device-aware EV rates, and octopus_get_ev_charge_costs for device-aware EV charge history. Respect truncated flags and unit/cost warnings. Requests are locally throttled and cached. Credentials may only be sent to api.octopus.energy; never ask the user to paste them into chat. octopus_clear_cache only deletes local response files and requires confirm=true." +
        (updateNotice ? ` IMPORTANT: Tell the user about this update before using other tools. ${updateNotice}` : "")
    }
  );

  const consumptionFor = async (
    args: PeriodLike & MeterLike & { group_by?: "half_hour" | "day" | "week" | "month" | "quarter" },
    rangeOverride?: PeriodRange
  ) => {
    const range = rangeOverride ?? resolvePeriod(args, config.timezone);
    const { group_by, ...selection } = args;
    const result = await rest.getConsumption({
      ...selection,
      period_from: range.from,
      period_to: range.to,
      ...(group_by && group_by !== "half_hour" ? { group_by } : {})
    });
    return { range, ...result };
  };

  server.registerTool(
    "octopus_connection_status",
    {
      title: "Octopus connection status",
      description: "Show privacy-safe configuration, local cache, and local rate-limiter status without contacting Octopus.",
      inputSchema: z.object({}),
      annotations: { ...readOnly, openWorldHint: false }
    },
    safe(async () => ({
      ready_for_account_queries: Boolean(config.apiKey && config.accountNumber),
      configuration: publicConfig(config),
      update: updateStatus,
      cache: await cache.stats(),
      local_rate_limiter: limiter.snapshot(),
      privacy: {
        transport: "local stdio",
        outbound_allowlist: [
          "api.octopus.energy",
          ...(config.updateCheckEnabled ? ["api.github.com"] : [])
        ],
        credentials_logged: false,
        graphql_tokens_persisted: false,
        telemetry: false
      }
    }))
  );

  server.registerTool(
    "octopus_get_account",
    {
      title: "Get Octopus account",
      description: "Fetch properties, meter points, meters and tariff agreements. Addresses are omitted unless explicitly requested.",
      inputSchema: z.object({
        account_number: z.string().optional(),
        include_addresses: z.boolean().default(false)
      }),
      annotations: readOnly
    },
    safe(async ({ account_number, include_addresses }) => {
      const account = await rest.getAccount(account_number);
      return include_addresses ? account : redactAccountAddresses(account);
    })
  );

  server.registerTool(
    "octopus_discover_meters",
    {
      title: "Discover meters and tariffs",
      description: "List electricity import/export and gas meters, their meter points and current tariff agreements.",
      inputSchema: z.object({ account_number: z.string().optional() }),
      annotations: readOnly
    },
    safe(async ({ account_number }) => ({ meters: await rest.discoverMeters(account_number) }))
  );

  server.registerTool(
    "octopus_list_products",
    {
      title: "List Octopus products",
      description: "Search the public Octopus product catalogue using supported server-side filters.",
      inputSchema: z.object({
        available_at: z.string().optional(),
        is_variable: z.boolean().optional(),
        is_green: z.boolean().optional(),
        is_prepay: z.boolean().optional(),
        is_business: z.boolean().optional(),
        brand: z.string().optional()
      }),
      annotations: readOnly
    },
    safe(async (args) => rest.listProducts(args))
  );

  server.registerTool(
    "octopus_get_product",
    {
      title: "Get Octopus product",
      description: "Get public tariff and product metadata for one exact product code.",
      inputSchema: z.object({ product_code: z.string().min(1) }),
      annotations: readOnly
    },
    safe(async ({ product_code }) => rest.getProduct(product_code.toUpperCase()))
  );

  server.registerTool(
    "octopus_get_consumption",
    {
      title: "Get energy consumption",
      description: "Fetch bounded, paginated meter consumption for a named or custom period. Use meter filters when an account has multiple matches.",
      inputSchema: z.object({
        ...periodFields,
        ...meterFields,
        group_by: z.enum(["half_hour", "day", "week", "month", "quarter"]).default("half_hour")
      }),
      annotations: readOnly
    },
    safe(async (args) => consumptionFor(args))
  );

  server.registerTool(
    "octopus_analyse_usage",
    {
      title: "Analyse energy usage",
      description: "Calculate totals, peaks, daily/monthly patterns, hour and weekday profiles, gaps and coverage from Octopus consumption.",
      inputSchema: z.object({
        ...periodFields,
        ...meterFields,
        gas_unit: gasUnitField
      }),
      annotations: readOnly
    },
    safe(async (args) => {
      const result = await consumptionFor({ ...args, group_by: "half_hour" });
      const gasUnit = args.gas_unit ?? config.gasConsumptionUnit;
      return {
        meter: result.meter,
        requested_period: result.range,
        pagination: {
          api_count: result.data.count,
          records_returned: result.data.results.length,
          pages_fetched: result.data.pages_fetched,
          truncated: result.data.truncated,
          ...cacheProvenance(result.data)
        },
        analysis: analyseUsage(
          result.data.results,
          result.meter.fuel,
          config.timezone,
          gasUnit,
          config.gasM3ToKwhFactor,
          result.range
        )
      };
    })
  );

  server.registerTool(
    "octopus_compare_usage",
    {
      title: "Compare energy usage periods",
      description: "Compare a named/custom period with the previous equivalent period or with a second explicit range.",
      inputSchema: z.object({
        ...periodFields,
        comparison_from: z.string().optional(),
        comparison_to: z.string().optional(),
        ...meterFields,
        gas_unit: gasUnitField
      }),
      annotations: readOnly
    },
    safe(async (args) => {
      const currentRange = resolvePeriod(args, config.timezone);
      const comparisonRange = args.comparison_from || args.comparison_to
        ? resolvePeriod({ period_from: args.comparison_from, period_to: args.comparison_to }, config.timezone)
        : previousEquivalentPeriod(currentRange);
      const [current, comparison] = await Promise.all([
        consumptionFor({ ...args, group_by: "half_hour" }, currentRange),
        consumptionFor({ ...args, group_by: "half_hour" }, comparisonRange)
      ]);
      if (current.meter.meter_point !== comparison.meter.meter_point) {
        throw new Error("Meter selection changed between comparison calls");
      }
      const gasUnit = args.gas_unit ?? config.gasConsumptionUnit;
      const currentAnalysis = analyseUsage(
        current.data.results,
        current.meter.fuel,
        config.timezone,
        gasUnit,
        config.gasM3ToKwhFactor,
        currentRange
      );
      const comparisonAnalysis = analyseUsage(
        comparison.data.results,
        comparison.meter.fuel,
        config.timezone,
        gasUnit,
        config.gasM3ToKwhFactor,
        comparisonRange
      );
      if (current.data.stale_cache_used) {
        currentAnalysis.warnings.unshift("Current-period consumption came from an expired cache after a transient API failure.");
      }
      if (comparison.data.stale_cache_used) {
        comparisonAnalysis.warnings.unshift("Comparison-period consumption came from an expired cache after a transient API failure.");
      }
      return {
        meter: current.meter,
        current_period: currentRange,
        comparison_period: comparisonRange,
        cache: {
          current: cacheProvenance(current.data),
          comparison: cacheProvenance(comparison.data)
        },
        ...compareAnalyses(currentAnalysis, comparisonAnalysis)
      };
    })
  );

  const tariffSchema = z.object({
    fuel: z.enum(["electricity", "gas"]),
    tariff_code: z.string().min(1),
    product_code: z.string().min(1).optional(),
    ...periodFields
  });

  server.registerTool(
    "octopus_get_tariff_rates",
    {
      title: "Get tariff rates",
      description: "Fetch VAT-inclusive/exclusive unit rates and standing charges for an exact conventional tariff over a period. Use the EV pricing tool for device-aware four-rate tariffs.",
      inputSchema: tariffSchema,
      annotations: readOnly
    },
    safe(async (args) => {
      const target = targetFromInput(args);
      assertPublishedRateViewSupported(target.tariff_code);
      const range = resolvePeriod(args, config.timezone);
      if (isDualRegisterTariff(target.tariff_code)) {
        const [dayUnitRates, nightUnitRates, standingCharges] = await Promise.all([
          rest.getTariffRates(target, "day", range.from, range.to),
          rest.getTariffRates(target, "night", range.from, range.to),
          rest.getTariffRates(target, "standing", range.from, range.to)
        ]);
        return {
          target,
          requested_period: range,
          rate_structure: "dual_register",
          day_unit_rates: dayUnitRates,
          night_unit_rates: nightUnitRates,
          standing_charges: standingCharges,
          cost_replay_supported: false
        };
      }
      const [unitRates, standingCharges] = await Promise.all([
        rest.getTariffRates(target, "unit", range.from, range.to),
        rest.getTariffRates(target, "standing", range.from, range.to)
      ]);
      return {
        target,
        requested_period: range,
        rate_structure: "single_register",
        unit_rates: unitRates,
        standing_charges: standingCharges,
        cost_replay_supported: true
      };
    })
  );

  server.registerTool(
    "octopus_get_current_rates",
    {
      title: "Get current tariff rates",
      description: "Return current conventional single or register-specific day/night rates and standing charge. Use the EV pricing tool for device-aware four-rate tariffs.",
      inputSchema: z.object({
        fuel: z.enum(["electricity", "gas"]),
        tariff_code: z.string().min(1),
        product_code: z.string().min(1).optional()
      }),
      annotations: readOnly
    },
    safe(async (args) => {
      const target = targetFromInput(args);
      assertPublishedRateViewSupported(target.tariff_code);
      const now = DateTime.now();
      const from = now.minus({ hours: 2 }).toUTC().toISO()!;
      const to = now.plus({ hours: 24 }).toUTC().toISO()!;
      if (isDualRegisterTariff(target.tariff_code)) {
        const [dayUnitRates, nightUnitRates, standingCharges] = await Promise.all([
          rest.getTariffRates(target, "day", from, to),
          rest.getTariffRates(target, "night", from, to),
          rest.getTariffRates(target, "standing", from, to)
        ]);
        return {
          target,
          rate_structure: "dual_register",
          as_of: now.toUTC().toISO(),
          current_day_unit_rate: activeRate(dayUnitRates.results, now.toMillis()),
          current_night_unit_rate: activeRate(nightUnitRates.results, now.toMillis()),
          current_standing_charge: activeRate(standingCharges.results, now.toMillis()),
          cache: {
            day_unit_rates: cacheProvenance(dayUnitRates),
            night_unit_rates: cacheProvenance(nightUnitRates),
            standing_charges: cacheProvenance(standingCharges)
          },
          cost_replay_supported: false
        };
      }
      const [unitRates, standingCharges] = await Promise.all([
        rest.getTariffRates(target, "unit", from, to),
        rest.getTariffRates(target, "standing", from, to)
      ]);
      return {
        target,
        as_of: now.toUTC().toISO(),
        current_unit_rate: activeRate(unitRates.results, now.toMillis()),
        current_standing_charge: activeRate(standingCharges.results, now.toMillis()),
        cache: {
          unit_rates: cacheProvenance(unitRates),
          standing_charges: cacheProvenance(standingCharges)
        },
        upcoming_unit_rates: unitRates.results
          .filter((rate) => Date.parse(rate.valid_from) >= now.toMillis())
          .sort((a, b) => Date.parse(a.valid_from) - Date.parse(b.valid_from))
      };
    })
  );

  server.registerTool(
    "octopus_find_cheapest_windows",
    {
      title: "Find cheapest tariff windows",
      description: "Find the cheapest contiguous half-hour windows in conventional published rates, useful for Agile-style tariffs. Device-aware EV schedules must use Octopus account pricing instead.",
      inputSchema: z.object({
        fuel: z.enum(["electricity", "gas"]).default("electricity"),
        tariff_code: z.string().min(1),
        product_code: z.string().min(1).optional(),
        ...periodFields,
        duration_minutes: z.number().int().min(30).max(24 * 60).multipleOf(30).default(120),
        limit: z.number().int().min(1).max(50).default(10)
      }),
      annotations: readOnly
    },
    safe(async (args) => {
      const target = targetFromInput(args);
      assertPublishedRateViewSupported(target.tariff_code);
      if (isDualRegisterTariff(target.tariff_code)) {
        throw new Error("Cheapest time windows are not available for register-based day/night tariffs");
      }
      const range = resolvePeriod(args, config.timezone);
      const rates = await rest.getTariffRates(target, "unit", range.from, range.to);
      return {
        target,
        requested_period: range,
        duration_minutes: args.duration_minutes,
        windows: findCheapestWindows(rates.results, args.duration_minutes / 30, args.limit),
        rates_truncated: rates.truncated,
        rates_cache: cacheProvenance(rates)
      };
    })
  );

  const costInput = z.object({
    ...periodFields,
    ...meterFields,
    gas_unit: gasUnitField,
    tariff_fuel: z.enum(["electricity", "gas"]).optional(),
    tariff_code: z.string().min(1),
    product_code: z.string().min(1).optional(),
    label: z.string().optional()
  });

  const calculateEstimate = async (
    records: ConsumptionRecord[],
    meter: MeterDescriptor,
    range: PeriodRange,
    target: TariffTarget,
    gasUnit: GasConsumptionUnit
  ) => {
    if (target.fuel !== meter.fuel) throw new Error("Tariff fuel must match the selected meter fuel");
    assertCostTariffSupported(target.tariff_code);
    if (meter.direction === "export") {
      throw new Error("Cost replay supports import meters only; export readings represent tariff revenue, not usage cost");
    }
    const normalized = normalizeConsumption(records, meter.fuel, gasUnit, config.gasM3ToKwhFactor);
    if (normalized.unit !== "kWh") {
      throw new Error("Cost estimation needs consumption in kWh; set gas_unit to kwh or m3 for gas meters");
    }
    const [unitRates, standingCharges] = await Promise.all([
      rest.getTariffRates(target, "unit", range.from, range.to),
      rest.getTariffRates(target, "standing", range.from, range.to)
    ]);
    const estimate = estimateCost(
      normalized.records,
      unitRates.results,
      standingCharges.results,
      target,
      config.timezone,
      range
    );
    estimate.warnings.unshift(...normalized.warnings);
    if (unitRates.stale_cache_used) {
      estimate.warnings.unshift("Unit rates came from an expired cache after a transient API failure.");
    }
    if (standingCharges.stale_cache_used) {
      estimate.warnings.unshift("Standing charges came from an expired cache after a transient API failure.");
    }
    if (unitRates.truncated || standingCharges.truncated) {
      estimate.warnings.unshift("One or more rate responses were truncated by configured safety limits.");
    }
    return estimate;
  };

  server.registerTool(
    "octopus_estimate_cost",
    {
      title: "Estimate tariff cost",
      description: "Replay import consumption against one single-register tariff's unit rates and standing charges. This is an estimate, not a bill.",
      inputSchema: costInput,
      annotations: readOnly
    },
    safe(async (args) => {
      assertCostTariffSupported(args.tariff_code);
      const usage = await consumptionFor({ ...args, fuel: args.fuel ?? args.tariff_fuel, group_by: "half_hour" });
      const target = targetFromInput({
        fuel: args.tariff_fuel ?? usage.meter.fuel,
        tariff_code: args.tariff_code,
        ...(args.product_code ? { product_code: args.product_code } : {}),
        ...(args.label ? { label: args.label } : {})
      });
      const estimate = await calculateEstimate(
        usage.data.results,
        usage.meter,
        usage.range,
        target,
        args.gas_unit ?? config.gasConsumptionUnit
      );
      if (usage.data.stale_cache_used) {
        estimate.warnings.unshift("Consumption came from an expired cache after a transient API failure.");
      }
      return { meter: usage.meter, requested_period: usage.range, estimate };
    })
  );

  server.registerTool(
    "octopus_compare_tariffs",
    {
      title: "Compare tariff costs",
      description: "Replay the same import consumption against up to ten single-register tariffs and rank the estimated totals.",
      inputSchema: z.object({
        ...periodFields,
        ...meterFields,
        gas_unit: gasUnitField,
        tariffs: z.array(z.object({
          label: z.string().optional(),
          fuel: z.enum(["electricity", "gas"]),
          tariff_code: z.string().min(1),
          product_code: z.string().min(1).optional()
        })).min(2).max(10)
      }),
      annotations: readOnly
    },
    safe(async (args) => {
      for (const tariff of args.tariffs) assertCostTariffSupported(tariff.tariff_code);
      const usage = await consumptionFor({ ...args, group_by: "half_hour" });
      const estimates = await Promise.all(
        args.tariffs.map((item) => calculateEstimate(
          usage.data.results,
          usage.meter,
          usage.range,
          targetFromInput(item),
          args.gas_unit ?? config.gasConsumptionUnit
        ))
      );
      if (usage.data.stale_cache_used) {
        for (const estimate of estimates) {
          estimate.warnings.unshift("Consumption came from an expired cache after a transient API failure.");
        }
      }
      estimates.sort((a, b) => a.total_cost_pence - b.total_cost_pence);
      const cheapest = estimates[0];
      return {
        meter: usage.meter,
        requested_period: usage.range,
        ranking: estimates.map((estimate, index) => ({
          rank: index + 1,
          ...estimate,
          saving_vs_most_expensive_gbp: Number(
            ((estimates.at(-1)!.total_cost_pence - estimate.total_cost_pence) / 100).toFixed(2)
          ),
          extra_vs_cheapest_gbp: Number(((estimate.total_cost_pence - cheapest!.total_cost_pence) / 100).toFixed(2))
        }))
      };
    })
  );

  server.registerTool(
    "octopus_get_smart_flex_devices",
    {
      title: "Get SmartFlex devices",
      description: "Use Octopus's read-only GraphQL API to list registered EV, battery, heat-pump and other SmartFlex devices.",
      inputSchema: z.object({ account_number: z.string().optional() }),
      annotations: readOnly
    },
    safe(async ({ account_number }) => graphql.getDevices(account_number))
  );

  server.registerTool(
    "octopus_get_smart_meter_devices",
    {
      title: "Get smart meter devices",
      description: "Discover SMETS2 Home Area Networks and ESME/GSME device IDs suitable for the telemetry tool.",
      inputSchema: z.object({ account_number: z.string().optional() }),
      annotations: readOnly
    },
    safe(async ({ account_number }) => graphql.getSmartMeterDevices(account_number))
  );

  server.registerTool(
    "octopus_get_smart_meter_telemetry",
    {
      title: "Get smart meter telemetry",
      description: "Read live/recent smart meter telemetry through Octopus GraphQL. This can be subject to a field-specific Octopus limit.",
      inputSchema: z.object({
        device_id: z.string().optional(),
        ...periodFields,
        grouping: z.enum(["TEN_SECONDS", "ONE_MINUTE", "FIVE_MINUTES", "HALF_HOURLY", "HOURLY"])
          .default("FIVE_MINUTES")
      }),
      annotations: readOnly
    },
    safe(async (args) => {
      const ranged = Boolean(args.period || args.period_from || args.period_to);
      const range = ranged ? resolvePeriod(args, config.timezone) : null;
      return {
        requested_period: range,
        mode: range ? "range" : "latest",
        data: await graphql.getSmartMeterTelemetry({
          ...(args.device_id ? { deviceId: args.device_id } : {}),
          ...(range ? { start: range.from, end: range.to, grouping: args.grouping } : {})
        })
      };
    })
  );

  server.registerTool(
    "octopus_get_completed_dispatches",
    {
      title: "Get completed smart dispatches",
      description: "Read completed Intelligent Octopus/smart-flex dispatch records through Octopus GraphQL.",
      inputSchema: z.object({ account_number: z.string().optional() }),
      annotations: readOnly
    },
    safe(async ({ account_number }) => graphql.getCompletedDispatches(account_number))
  );

  server.registerTool(
    "octopus_get_ev_tariff_pricing",
    {
      title: "Get active four-rate EV tariff pricing",
      description: "Return the separate home peak/off-peak and EV peak/off-peak prices for active four-rate Intelligent Octopus Go agreements. Prices come from the authenticated Octopus account.",
      inputSchema: z.object({ account_number: z.string().optional() }),
      annotations: readOnly
    },
    safe(async ({ account_number }) => {
      const data = await graphql.getEvTariffPricing(account_number);
      return {
        pricing_source: "Octopus Energy account FourRateEvTariff",
        pricing_model: "four_rate_ev_tariff",
        rate_units: {
          unit_rates: "pence per kWh",
          standing_charge: "pence per day"
        },
        active_electricity_agreements_examined: data.activeAgreementCount,
        four_rate_ev_tariffs: data.fourRateTariffs.map((agreement) => ({
          agreement_id: agreement.agreementId,
          valid_from: agreement.validFrom,
          valid_to: agreement.validTo,
          meter_point: agreement.meterPoint,
          tariff_id: agreement.tariff.id,
          tariff_code: agreement.tariff.tariffCode,
          product_code: agreement.tariff.productCode,
          display_name: agreement.tariff.displayName,
          full_name: agreement.tariff.fullName,
          is_export: agreement.tariff.isExport,
          rates_inc_vat_pence_per_kwh: {
            home_peak: agreement.tariff.dayRate,
            home_off_peak: agreement.tariff.nightRate,
            ev_peak: agreement.tariff.evDevicePeakRate,
            ev_off_peak: agreement.tariff.evDeviceOffPeakRate
          },
          rates_excl_vat_pence_per_kwh: {
            home_peak: agreement.tariff.preVatDayRate,
            home_off_peak: agreement.tariff.preVatNightRate,
            ev_peak: agreement.tariff.preVatEvDevicePeakRate,
            ev_off_peak: agreement.tariff.preVatEvDeviceOffPeakRate
          },
          standing_charge_inc_vat_pence_per_day: agreement.tariff.standingCharge,
          standing_charge_excl_vat_pence_per_day: agreement.tariff.preVatStandingCharge
        })),
        cache: cacheProvenance(data),
        caveats: [
          "An empty list means Octopus did not return an active FourRateEvTariff for this account; the rollout may not have reached the account or it may use another tariff model.",
          "For the new Intelligent Octopus Go model, home off-peak is normally 23:30–05:30 and the EV receives up to six off-peak smart-charging hours per midday-to-midday day. The Octopus app and account terms remain authoritative.",
          "Use octopus_get_ev_charge_costs for Octopus-priced historic charging consumption and costs."
        ]
      };
    })
  );

  server.registerTool(
    "octopus_get_ev_charge_costs",
    {
      title: "Get Octopus-priced EV charge costs",
      description: "Return Octopus account-priced EV charging consumption and costs. Use this for Intelligent Octopus Go four-rate/Charge Cap pricing and type-of-use EV arrangements instead of replaying aggregate meter rates.",
      inputSchema: z.object({
        account_number: z.string().optional(),
        ...periodFields,
        frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]).default("DAILY")
      }),
      annotations: readOnly
    },
    safe(async (args) => {
      const range = resolvePeriod(args, config.timezone);
      const dates = evChargeDateRange(range, config.timezone);
      const data = await graphql.getEvChargeCosts({
        ...(args.account_number ? { accountNumber: args.account_number } : {}),
        frequency: args.frequency,
        startDate: dates.start_date,
        reportDate: dates.report_date
      });
      return {
        requested_period: range,
        octopus_date_range: dates,
        frequency: args.frequency,
        pricing_source: "Octopus Energy account costOfCharge",
        pricing_model: "device_aware_ev_charging",
        summary: summarizeEvChargeCosts(data.costOfCharge),
        charges: data.costOfCharge,
        cache: cacheProvenance(data),
        caveats: [
          "These are Octopus-calculated EV charge costs, not a reconstruction from aggregate smart-meter consumption.",
          "Intelligent Octopus Go can price the home and EV differently in the same half-hour and limits the off-peak smart-charge allowance to six actual charging hours per midday-to-midday day.",
          "Intelligent Drive Pack and Power Pack are type-of-use arrangements. Subscription fees, credits, exports, or other account-level adjustments may appear separately from these charge records; use the Octopus statement as the definitive total."
        ]
      };
    })
  );

  server.registerTool(
    "octopus_get_planned_dispatches",
    {
      title: "Get planned smart dispatches",
      description: "Read planned dispatches for a configured or explicitly supplied smart-flex device.",
      inputSchema: z.object({ device_id: z.string().optional() }),
      annotations: readOnly
    },
    safe(async ({ device_id }) => graphql.getFlexPlannedDispatches(device_id))
  );

  server.registerTool(
    "octopus_get_octoplus_balance",
    {
      title: "Get Octoplus balance",
      description: "Read Octoplus loyalty points and their monetary value through Octopus GraphQL.",
      inputSchema: z.object({ account_number: z.string().optional() }),
      annotations: readOnly
    },
    safe(async ({ account_number }) => graphql.getLoyaltyPointsBalance(account_number))
  );

  server.registerTool(
    "octopus_get_api_rate_limits",
    {
      title: "Get API rate-limit status",
      description: "Return both this server's local throttle status and Octopus GraphQL's reported points/field limits.",
      inputSchema: z.object({}),
      annotations: readOnly
    },
    safe(async () => ({ local: limiter.snapshot(), octopus_graphql: await graphql.getRateLimitInfo() }))
  );

  server.registerTool(
    "octopus_clear_cache",
    {
      title: "Clear local Octopus cache",
      description: "Delete locally cached API responses. This never changes data at Octopus Energy.",
      inputSchema: z.object({
        namespace: z.string().optional().describe("Optional cache namespace; omit to clear all entries"),
        confirm: z.literal(true).describe("Must be true to confirm local cache deletion")
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    safe(async ({ namespace }) => ({ removed_entries: await cache.clear(namespace), namespace: namespace ?? "all" }))
  );

  server.registerResource(
    "privacy-and-configuration",
    "octopus://server/configuration",
    {
      title: "Octopus MCP privacy and configuration",
      description: "Credential-free runtime settings and privacy boundaries.",
      mimeType: "application/json"
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(publicConfig(config), null, 2) }]
    })
  );

  server.registerResource(
    "capabilities-guide",
    "octopus://help/capabilities",
    {
      title: "Octopus MCP capabilities guide",
      description: "How to choose account, consumption, analysis, tariff, and smart-device tools.",
      mimeType: "text/markdown"
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: CAPABILITIES_GUIDE }] })
  );

  server.registerPrompt(
    "analyse-my-energy",
    {
      title: "Analyse my energy use",
      description: "Guide an assistant through a privacy-conscious usage analysis.",
      argsSchema: z.object({
        fuel: z.enum(["electricity", "gas"]),
        period: z.enum(PERIOD_ALIASES).default("last_30_days")
      })
    },
    ({ fuel, period }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Analyse my ${fuel} use for ${period}. First discover the matching meter, then run octopus_analyse_usage. Explain totals, peak times, routines, data gaps, and practical opportunities. State units and caveats; do not expose my address or credentials.`
        }
      }]
    })
  );

  server.registerPrompt(
    "compare-my-tariffs",
    {
      title: "Compare tariffs with actual usage",
      description: "Guide an assistant to replay actual consumption against exact tariff codes.",
      argsSchema: z.object({
        tariff_codes: z.string().describe("Comma-separated exact tariff codes"),
        period: z.enum(PERIOD_ALIASES).default("last_30_days")
      })
    },
    ({ tariff_codes, period }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Compare these exact Octopus tariff codes using my actual ${period} consumption: ${tariff_codes}. Discover the relevant meter, verify fuel/product codes, then use octopus_compare_tariffs. Rank estimated totals and clearly distinguish the estimate from an Octopus bill or a recommendation.`
        }
      }]
    })
  );

  return server;
}

const CAPABILITIES_GUIDE = `# Octopus Energy private MCP

This local stdio server sends credentials and account identifiers only to \`api.octopus.energy\`.
At startup, an optional anonymous version check reads only the public package version from \`api.github.com\`; its result is included in \`octopus_connection_status\`.

1. Start with \`octopus_connection_status\` and \`octopus_discover_meters\`.
2. Use \`octopus_get_consumption\` for raw intervals or server-side grouping.
3. Use \`octopus_analyse_usage\` and \`octopus_compare_usage\` for local calculations.
4. Use exact tariff codes with rate, cheapest-window, cost, and comparison tools for conventional tariffs.
5. Use \`octopus_get_ev_tariff_pricing\` for an account's separate home peak/off-peak and EV peak/off-peak rates.
6. Use \`octopus_get_ev_charge_costs\` for Intelligent Octopus Go, Charge Cap, Drive Pack, Power Pack, and other device-aware EV charge costs; aggregate meter replay cannot reproduce those rules.
7. Device telemetry, dispatches, Octoplus points, and Octopus quota status use documented read-only GraphQL operations.

Every Octopus Energy request is queued behind the configured local throttle. Pagination and record counts are capped per tool call, and repeatable responses are cached locally with hashed filenames.
`;
