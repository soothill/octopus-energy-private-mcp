export interface SiteConfig {
  slug: string;
  name: string;
  apiKey: string;
  accountNumber: string;
}

export interface PollerConfig {
  sites: SiteConfig[];
  timezone: string;
  influx: {
    baseUrl: string;
    token: string;
    org: string;
    bucket: string;
  };
  priceIntervalMs: number;
  consumptionIntervalMs: number;
  backfillDays: number;
  lookaheadDays: number;
  minRequestIntervalMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
  measurementPrefix: string;
  marketImportProducts: string[];
  marketExportProducts: string[];
  battery: {
    sites: string[];
    capacityKwh: number;
    chargeKw: number;
    dischargeKw: number;
    efficiency: number;
    cheapImportPence: number;
    cheapImportWindow: string;
    reserveKwh: number;
    plannerImportProduct: string;
    plannerExportProduct: string;
  };
  report: {
    enabled: boolean;
    site: string;
    smtpHost: string;
    smtpPort: number;
    from: string;
    to: string;
    time: string;
    goDayPence: number;
    sigenergyBucket: string;
  };
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function required(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return parsed;
}

export function siteSlug(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`Invalid site name "${value}"`);
  return slug;
}

function siteEnvSuffix(slug: string): string {
  return slug.replace(/-/g, "_").toUpperCase();
}

function loadSites(): SiteConfig[] {
  const list = env("OCTOPUS_SITES");
  const slugs = list
    ? list.split(",").map((entry) => siteSlug(entry)).filter(Boolean)
    : env("OCTOPUS_API_KEY") ? ["default"] : [];
  if (slugs.length === 0) {
    throw new Error("Set OCTOPUS_SITES with per-site keys, or OCTOPUS_API_KEY/OCTOPUS_ACCOUNT_NUMBER for one site");
  }
  return slugs.map((slug) => {
    const prefix = slug === "default" ? "OCTOPUS_" : `OCTOPUS_SITE_${siteEnvSuffix(slug)}_`;
    const apiKey = env(`${prefix}API_KEY`);
    const accountNumber = env(`${prefix}ACCOUNT_NUMBER`);
    if (!apiKey || !accountNumber) {
      throw new Error(`Site "${slug}" needs ${prefix}API_KEY and ${prefix}ACCOUNT_NUMBER`);
    }
    if (!/^A-[A-Z0-9]+$/i.test(accountNumber)) {
      throw new Error(`Site "${slug}" account number must look like A-XXXXXXXX`);
    }
    return {
      slug,
      name: env(`${prefix}NAME`) ?? slug,
      apiKey,
      accountNumber: accountNumber.toUpperCase()
    };
  });
}

export function loadPollerConfig(): PollerConfig {
  const influxBaseUrl = (env("INFLUX_URL") ?? "http://localhost:8086").replace(/\/+$/, "");
  return {
    sites: loadSites(),
    timezone: env("POLLER_TIMEZONE") ?? "Europe/London",
    influx: {
      baseUrl: influxBaseUrl,
      token: required("INFLUX_TOKEN"),
      org: required("INFLUX_ORG"),
      bucket: required("INFLUX_BUCKET")
    },
    priceIntervalMs: integerEnv("POLL_PRICE_INTERVAL_MINUTES", 30, 5, 720) * 60_000,
    consumptionIntervalMs: integerEnv("POLL_CONSUMPTION_INTERVAL_MINUTES", 15, 5, 720) * 60_000,
    backfillDays: integerEnv("POLL_BACKFILL_DAYS", 30, 0, 365),
    lookaheadDays: integerEnv("POLL_LOOKAHEAD_DAYS", 2, 1, 4),
    minRequestIntervalMs: integerEnv("POLL_MIN_REQUEST_INTERVAL_MS", 1000, 100, 60_000),
    requestTimeoutMs: integerEnv("POLL_REQUEST_TIMEOUT_MS", 20_000, 1000, 120_000),
    maxRetries: integerEnv("POLL_MAX_RETRIES", 3, 0, 8),
    measurementPrefix: env("INFLUX_MEASUREMENT_PREFIX") ?? "octopus_",
    marketImportProducts: (env("POLL_MARKET_IMPORT_PRODUCTS") ?? "AGILE-24-10-01")
      .split(",")
      .map((product) => product.trim().toUpperCase())
      .filter(Boolean),
    marketExportProducts: (env("POLL_MARKET_EXPORT_PRODUCTS") ?? "AGILE-OUTGOING-19-05-13,OUTGOING-VAR-24-10-26,OUTGOING-PRIME-FIX-12M-26-06-23")
      .split(",")
      .map((product) => product.trim().toUpperCase())
      .filter(Boolean),
    battery: {
      sites: (env("BATTERY_PLAN_SITES") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => siteSlug(entry)),
      capacityKwh: numberEnv("BATTERY_CAPACITY_KWH", 9, 0.5, 100),
      chargeKw: numberEnv("BATTERY_CHARGE_KW", 4.4, 0.1, 50),
      dischargeKw: numberEnv("BATTERY_DISCHARGE_KW", 7.2, 0.1, 50),
      efficiency: numberEnv("BATTERY_EFFICIENCY", 0.9, 0.5, 1),
      cheapImportPence: numberEnv("BATTERY_CHEAP_IMPORT_PENCE", 7, 0, 100),
      cheapImportWindow: env("BATTERY_CHEAP_IMPORT_WINDOW") ?? "00:30-05:30",
      reserveKwh: numberEnv("BATTERY_RESERVE_KWH", 2, 0, 100),
      plannerImportProduct: (env("PLANNER_IMPORT_PRODUCT") ?? "AGILE-24-10-01").trim().toUpperCase(),
      plannerExportProduct: (env("PLANNER_EXPORT_PRODUCT") ?? "AGILE-OUTGOING-19-05-13").trim().toUpperCase()
    },
    report: {
      enabled: (env("REPORT_ENABLED") ?? "").toLowerCase() === "true",
      site: env("REPORT_SITE") ?? "york",
      smtpHost: env("REPORT_SMTP_HOST") ?? "yorkstorj",
      smtpPort: integerEnv("REPORT_SMTP_PORT", 25, 1, 65535),
      from: env("REPORT_FROM") ?? "octopus-poller@soothill.com",
      to: env("REPORT_TO") ?? "",
      time: env("REPORT_TIME") ?? "07:30",
      goDayPence: numberEnv("REPORT_GO_DAY_PENCE", 26.07, 0, 200),
      sigenergyBucket: env("REPORT_SIGENERGY_BUCKET") ?? "sigenergy"
    }
  };
}
