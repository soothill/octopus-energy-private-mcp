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
    measurementPrefix: env("INFLUX_MEASUREMENT_PREFIX") ?? "octopus_"
  };
}
