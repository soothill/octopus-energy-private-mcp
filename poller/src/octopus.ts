import type { SiteConfig } from "./config.js";

const OCTOPUS_ORIGIN = "https://api.octopus.energy";
const OCTOPUS_BASE = `${OCTOPUS_ORIGIN}/v1/`;

export interface RateRecord {
  value_exc_vat: number;
  value_inc_vat: number;
  valid_from: string;
  valid_to: string | null;
}

export interface ConsumptionRecord {
  interval_start: string;
  interval_end: string;
  consumption: number;
}

export interface MeterTarget {
  mpan: string;
  serial_number: string;
  tariff_code: string;
  product_code: string;
  direction: "import" | "export";
}

interface Paged<T> {
  count: number;
  next: string | null;
  results: T[];
}

interface Agreement {
  tariff_code: string;
  valid_from: string;
  valid_to: string | null;
}

interface MeterPoint {
  mpan: string;
  is_export?: boolean;
  meters: Array<{ serial_number: string }>;
  agreements: Agreement[];
}

interface AccountResponse {
  number: string;
  properties: Array<{ electricity_meter_points: MeterPoint[] }>;
}

export function productCodeFromTariff(tariffCode: string): string {
  const match = tariffCode.trim().toUpperCase().match(/^[EG]-\dR-(.+)-[A-Z]$/);
  if (!match?.[1]) throw new Error(`Could not derive product code from ${tariffCode}`);
  return match[1];
}

function activeAgreement(agreements: Agreement[], now: number): Agreement | null {
  return agreements.find(
    (agreement) =>
      Date.parse(agreement.valid_from) <= now &&
      (!agreement.valid_to || Date.parse(agreement.valid_to) > now)
  ) ?? null;
}

export class OctopusPollerClient {
  private lastRequestAt = 0;

  constructor(
    readonly site: SiteConfig,
    private readonly options: {
      timeoutMs: number;
      maxRetries: number;
      minRequestIntervalMs: number;
      fetchFn?: typeof globalThis.fetch;
    }
  ) {}

  private get fetchFn(): typeof globalThis.fetch {
    return this.options.fetchFn ?? globalThis.fetch;
  }

  private safeUrl(input: string): URL {
    const url = new URL(input, OCTOPUS_BASE);
    if (url.origin !== OCTOPUS_ORIGIN || url.protocol !== "https:") {
      throw new Error(`Blocked outbound URL; only ${OCTOPUS_ORIGIN} is allowed`);
    }
    return url;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async requestJson<T>(url: URL, authenticated: boolean): Promise<T> {
    const credential = Buffer.from(`${this.site.apiKey}:`, "utf8").toString("base64");
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      const wait = this.lastRequestAt + this.options.minRequestIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();
      try {
        const response = await this.fetchFn(url, {
          headers: {
            Accept: "application/json",
            ...(authenticated ? { Authorization: `Basic ${credential}` } : {})
          },
          redirect: "manual",
          signal: AbortSignal.timeout(this.options.timeoutMs)
        });
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`Octopus returned HTTP ${response.status}`);
          const retryAfter = Number(response.headers.get("retry-after"));
          await this.sleep(Number.isFinite(retryAfter) ? Math.min(120_000, retryAfter * 1000) : 750 * 2 ** attempt);
          continue;
        }
        if (!response.ok) throw new Error(`Octopus returned HTTP ${response.status} for ${url.pathname}`);
        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
        if (attempt >= this.options.maxRetries) break;
        await this.sleep(750 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Octopus request failed");
  }

  private async paginate<T>(url: URL, authenticated: boolean): Promise<T[]> {
    const results: T[] = [];
    let next: URL | null = url;
    while (next) {
      const page: Paged<T> = await this.requestJson<Paged<T>>(next, authenticated);
      results.push(...page.results);
      next = page.next ? this.safeUrl(page.next) : null;
    }
    return results;
  }

  /** Discover the active import and export electricity meters for the site. */
  async discoverTargets(): Promise<MeterTarget[]> {
    const account = await this.requestJson<AccountResponse>(
      this.safeUrl(`accounts/${encodeURIComponent(this.site.accountNumber)}/`),
      true
    );
    const now = Date.now();
    const targets: MeterTarget[] = [];
    for (const property of account.properties) {
      for (const point of property.electricity_meter_points ?? []) {
        const agreement = activeAgreement(point.agreements ?? [], now);
        if (!agreement) continue;
        const meter = point.meters?.[0];
        if (!meter) continue;
        let product_code: string;
        try {
          product_code = productCodeFromTariff(agreement.tariff_code);
        } catch {
          continue;
        }
        targets.push({
          mpan: point.mpan,
          serial_number: meter.serial_number,
          tariff_code: agreement.tariff_code.toUpperCase(),
          product_code,
          direction: point.is_export ? "export" : "import"
        });
      }
    }
    if (targets.length === 0) {
      throw new Error(`No active electricity agreements found for ${this.site.accountNumber}`);
    }
    return targets;
  }

  /** Half-hourly unit rates for a tariff over a window (works past, present and day-ahead). */
  async getRates(target: MeterTarget, periodFrom: Date, periodTo: Date): Promise<RateRecord[]> {
    const tariffType = target.tariff_code.startsWith("E-") ? "electricity-tariffs" : "gas-tariffs";
    const url = this.safeUrl(
      `products/${encodeURIComponent(target.product_code)}/${tariffType}/${encodeURIComponent(target.tariff_code)}/standard-unit-rates/`
    );
    url.searchParams.set("period_from", periodFrom.toISOString());
    url.searchParams.set("period_to", periodTo.toISOString());
    url.searchParams.set("page_size", "1500");
    return this.paginate<RateRecord>(url, false);
  }

  /** Half-hourly meter readings; export MPANs report exported kWh as "consumption". */
  async getConsumption(target: MeterTarget, periodFrom: Date, periodTo: Date): Promise<ConsumptionRecord[]> {
    const url = this.safeUrl(
      `electricity-meter-points/${encodeURIComponent(target.mpan)}/meters/${encodeURIComponent(target.serial_number)}/consumption/`
    );
    url.searchParams.set("period_from", periodFrom.toISOString());
    url.searchParams.set("period_to", periodTo.toISOString());
    url.searchParams.set("order_by", "period");
    url.searchParams.set("page_size", "1500");
    return this.paginate<ConsumptionRecord>(url, true);
  }
}
