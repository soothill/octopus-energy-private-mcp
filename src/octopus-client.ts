import type { FileCache } from "./cache.js";
import {
  OCTOPUS_REST_BASE_URL,
  OCTOPUS_REST_ORIGIN,
  type ServerConfig
} from "./config.js";
import type { RequestRateLimiter } from "./rate-limiter.js";
import type {
  Account,
  ConsumptionRecord,
  Direction,
  Fuel,
  MeterDescriptor,
  PagedResponse,
  PaginatedResult,
  Product,
  RateRecord
} from "./types.js";

export interface RequestResult<T> {
  data: T;
  cache: "hit" | "miss" | "stale" | "disabled";
  cache_age_ms?: number;
}

export interface OctopusClientOptions {
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  allowedOrigin?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

export interface MeterSelector {
  fuel?: Fuel;
  direction?: Direction;
  property_id?: number;
  meter_point?: string;
  serial_number?: string;
}

export interface ConsumptionOptions extends MeterSelector {
  period_from: string;
  period_to: string;
  group_by?: "day" | "week" | "month" | "quarter";
  order_by?: "period" | "-period";
  page_size?: number;
}

interface RequestOptions {
  authenticated: boolean;
  cacheNamespace: string;
  cacheTtlMs: number;
  allowStaleOnError?: boolean;
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
}

export class OctopusApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false
  ) {
    super(message);
    this.name = "OctopusApiError";
  }
}

export class OctopusRestClient {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly allowedOrigin: string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly inFlight = new Map<string, Promise<RequestResult<unknown>>>();

  constructor(
    readonly config: ServerConfig,
    readonly cache: FileCache,
    readonly limiter: RequestRateLimiter,
    options: OctopusClientOptions = {}
  ) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? OCTOPUS_REST_BASE_URL;
    this.allowedOrigin = options.allowedOrigin ?? OCTOPUS_REST_ORIGIN;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
  }

  private requireApiKey(): string {
    if (!this.config.apiKey) {
      throw new Error("OCTOPUS_API_KEY is required for account and consumption data");
    }
    return this.config.apiKey;
  }

  requireAccountNumber(override?: string): string {
    const account = override?.trim().toUpperCase() || this.config.accountNumber;
    if (!account) throw new Error("OCTOPUS_ACCOUNT_NUMBER is required for this operation");
    if (!/^A-[A-Z0-9]+$/.test(account)) throw new Error("Account number must look like A-XXXXXXXX");
    return account;
  }

  private safeUrl(input: string | URL): URL {
    const url = input instanceof URL ? input : new URL(input, this.baseUrl);
    if (url.origin !== this.allowedOrigin || url.protocol !== "https:") {
      throw new Error(`Blocked outbound URL; only ${this.allowedOrigin} is allowed`);
    }
    return url;
  }

  private cacheKey(url: URL, options: RequestOptions): string {
    const body = options.body ? JSON.stringify(options.body) : "";
    return `rest:${options.method ?? "GET"}:${url.toString()}:${body}`;
  }

  private retryDelay(response: Response | undefined, attempt: number): number {
    const header = response?.headers.get("retry-after");
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds)) return Math.min(120_000, Math.max(0, seconds * 1000));
      const date = Date.parse(header);
      if (Number.isFinite(date)) return Math.min(120_000, Math.max(0, date - Date.now()));
    }
    const exponential = Math.min(30_000, 750 * 2 ** attempt);
    return exponential + Math.floor(this.random() * 250);
  }

  private safeApiMessage(payload: unknown, status: number): string {
    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      for (const key of ["detail", "message", "error"]) {
        if (typeof record[key] === "string") {
          const message = this.config.apiKey ? record[key].replaceAll(this.config.apiKey, "[REDACTED]") : record[key];
          return `Octopus Energy API returned ${status}: ${message}`;
        }
      }
    }
    return `Octopus Energy API returned HTTP ${status}`;
  }

  async requestJson<T>(input: string | URL, options: RequestOptions): Promise<RequestResult<T>> {
    const url = this.safeUrl(input);
    const key = this.cacheKey(url, options);
    const cached = await this.cache.get<T>(key);
    if (cached) return { data: cached.value, cache: "hit", cache_age_ms: cached.ageMs };

    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<RequestResult<T>>;
    const operation = this.performRequest<T>(url, key, options).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, operation as Promise<RequestResult<unknown>>);
    return operation;
  }

  private async performRequest<T>(url: URL, key: string, options: RequestOptions): Promise<RequestResult<T>> {
    const stale = options.allowStaleOnError ? await this.cache.get<T>(key, true) : null;
    let finalError: unknown;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      let response: Response | undefined;
      try {
        await this.limiter.acquire();
        const headers = new Headers({ Accept: "application/json", ...options.headers });
        if (options.authenticated) {
          const credential = Buffer.from(`${this.requireApiKey()}:`, "utf8").toString("base64");
          headers.set("Authorization", `Basic ${credential}`);
        }
        if (options.body !== undefined) headers.set("Content-Type", "application/json");
        response = await this.fetchFn(url, {
          method: options.method ?? "GET",
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: AbortSignal.timeout(this.config.timeoutMs)
        });
        const text = await response.text();
        let payload: unknown = null;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch {
            throw new OctopusApiError(`Octopus Energy API returned non-JSON HTTP ${response.status}`, response.status);
          }
        }
        if (response.ok) {
          await this.cache.set(key, options.cacheNamespace, payload as T, options.cacheTtlMs);
          return { data: payload as T, cache: this.cache.enabled ? "miss" : "disabled" };
        }
        const retryable = response.status === 429 || response.status >= 500;
        finalError = new OctopusApiError(this.safeApiMessage(payload, response.status), response.status, retryable);
        if (!retryable || attempt >= this.config.maxRetries) break;
      } catch (error) {
        finalError = error;
        const retryable =
          error instanceof TypeError ||
          (error instanceof DOMException && error.name === "TimeoutError") ||
          (error instanceof OctopusApiError && error.retryable);
        if (!retryable || attempt >= this.config.maxRetries) break;
      }
      await this.sleep(this.retryDelay(response, attempt));
    }
    if (stale) return { data: stale.value, cache: "stale", cache_age_ms: stale.ageMs };
    if (finalError instanceof Error) throw finalError;
    throw new Error("Octopus Energy API request failed");
  }

  private async paginate<T>(
    input: string | URL,
    authenticated: boolean,
    namespace: string,
    cacheTtlMs: number,
    pageSize = this.config.pageSize
  ): Promise<PaginatedResult<T>> {
    let next: URL | null = this.safeUrl(input);
    next.searchParams.set("page_size", String(Math.min(pageSize, this.config.maxRecordsPerCall)));
    const results: T[] = [];
    let pagesFetched = 0;
    let count = 0;
    while (next && pagesFetched < this.config.maxPagesPerCall && results.length < this.config.maxRecordsPerCall) {
      const page: RequestResult<PagedResponse<T>> = await this.requestJson(next, {
        authenticated,
        cacheNamespace: namespace,
        cacheTtlMs,
        allowStaleOnError: true
      });
      count = page.data.count;
      results.push(...page.data.results.slice(0, this.config.maxRecordsPerCall - results.length));
      pagesFetched += 1;
      next = page.data.next ? this.safeUrl(page.data.next) : null;
    }
    return {
      count,
      results,
      pages_fetched: pagesFetched,
      truncated: Boolean(next) || results.length < count
    };
  }

  async getAccount(accountOverride?: string): Promise<Account> {
    const account = this.requireAccountNumber(accountOverride);
    const response = await this.requestJson<Account>(`accounts/${encodeURIComponent(account)}/`, {
      authenticated: true,
      cacheNamespace: "account",
      cacheTtlMs: 60 * 60 * 1000,
      allowStaleOnError: true
    });
    return response.data;
  }

  async discoverMeters(accountOverride?: string): Promise<MeterDescriptor[]> {
    const account = await this.getAccount(accountOverride);
    const now = Date.now();
    const descriptors: MeterDescriptor[] = [];
    for (const property of account.properties) {
      const propertyActive = !property.moved_out_at || Date.parse(property.moved_out_at) > now;
      for (const point of property.electricity_meter_points) {
        for (const meter of point.meters) {
          const activeAgreement = point.agreements.find(
            (agreement) =>
              Date.parse(agreement.valid_from) <= now &&
              (!agreement.valid_to || Date.parse(agreement.valid_to) > now)
          );
          descriptors.push({
            property_id: property.id,
            property_active: propertyActive,
            fuel: "electricity",
            direction: point.is_export ? "export" : "import",
            meter_point: point.mpan,
            serial_number: meter.serial_number,
            agreements: point.agreements,
            active_tariff_code: activeAgreement?.tariff_code ?? null,
            consumption_standard: point.consumption_standard ?? null
          });
        }
      }
      for (const point of property.gas_meter_points) {
        for (const meter of point.meters) {
          const activeAgreement = point.agreements.find(
            (agreement) =>
              Date.parse(agreement.valid_from) <= now &&
              (!agreement.valid_to || Date.parse(agreement.valid_to) > now)
          );
          descriptors.push({
            property_id: property.id,
            property_active: propertyActive,
            fuel: "gas",
            direction: "import",
            meter_point: point.mprn,
            serial_number: meter.serial_number,
            agreements: point.agreements,
            active_tariff_code: activeAgreement?.tariff_code ?? null,
            consumption_standard: point.consumption_standard ?? null
          });
        }
      }
    }
    return descriptors;
  }

  async selectMeter(selector: MeterSelector): Promise<MeterDescriptor> {
    let candidates = await this.discoverMeters();
    if (selector.fuel) candidates = candidates.filter((meter) => meter.fuel === selector.fuel);
    if (selector.direction) candidates = candidates.filter((meter) => meter.direction === selector.direction);
    if (selector.property_id !== undefined) {
      candidates = candidates.filter((meter) => meter.property_id === selector.property_id);
    }
    if (selector.meter_point) {
      candidates = candidates.filter((meter) => meter.meter_point === selector.meter_point);
    }
    if (selector.serial_number) {
      candidates = candidates.filter((meter) => meter.serial_number === selector.serial_number);
    }
    const active = candidates.filter((meter) => meter.property_active);
    if (active.length === 1) return active[0]!;
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length === 0) {
      throw new Error("No meter matched the supplied filters. Use octopus_discover_meters to inspect available meters.");
    }
    const choices = candidates.map(
      (meter) => `${meter.fuel}/${meter.direction} ${meter.meter_point} serial ${meter.serial_number}`
    );
    throw new Error(`Meter selection is ambiguous. Supply meter_point or serial_number. Matches: ${choices.join("; ")}`);
  }

  async getConsumption(options: ConsumptionOptions): Promise<{
    meter: MeterDescriptor;
    data: PaginatedResult<ConsumptionRecord>;
  }> {
    const meter = await this.selectMeter(options);
    const segment = meter.fuel === "electricity" ? "electricity-meter-points" : "gas-meter-points";
    const pointType = meter.fuel === "electricity" ? "mpan" : "mprn";
    const url = this.safeUrl(
      `${segment}/${encodeURIComponent(meter.meter_point)}/meters/${encodeURIComponent(meter.serial_number)}/consumption/`
    );
    url.searchParams.set("period_from", options.period_from);
    url.searchParams.set("period_to", options.period_to);
    url.searchParams.set("order_by", options.order_by ?? "period");
    if (options.group_by) url.searchParams.set("group_by", options.group_by);
    const historical = Date.parse(options.period_to) < Date.now() - 48 * 60 * 60 * 1000;
    const data = await this.paginate<ConsumptionRecord>(
      url,
      true,
      `consumption-${pointType}`,
      historical ? 24 * 60 * 60 * 1000 : 15 * 60 * 1000,
      options.page_size
    );
    return { meter, data };
  }

  async listProducts(filters: {
    available_at?: string;
    is_variable?: boolean;
    is_green?: boolean;
    is_prepay?: boolean;
    is_business?: boolean;
    brand?: string;
  } = {}): Promise<PaginatedResult<Product>> {
    const url = this.safeUrl("products/");
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return this.paginate<Product>(url, false, "products", 6 * 60 * 60 * 1000, 100);
  }

  async getProduct(productCode: string): Promise<Product> {
    const response = await this.requestJson<Product>(`products/${encodeURIComponent(productCode)}/`, {
      authenticated: false,
      cacheNamespace: "products",
      cacheTtlMs: 6 * 60 * 60 * 1000,
      allowStaleOnError: true
    });
    return response.data;
  }

  async getTariffRates(
    target: Pick<MeterDescriptor, "fuel"> & { product_code: string; tariff_code: string },
    kind: "unit" | "standing",
    periodFrom?: string,
    periodTo?: string
  ): Promise<PaginatedResult<RateRecord>> {
    const tariffType = target.fuel === "electricity" ? "electricity-tariffs" : "gas-tariffs";
    const rateType = kind === "unit" ? "standard-unit-rates" : "standing-charges";
    const url = this.safeUrl(
      `products/${encodeURIComponent(target.product_code)}/${tariffType}/${encodeURIComponent(target.tariff_code)}/${rateType}/`
    );
    if (periodFrom) url.searchParams.set("period_from", periodFrom);
    if (periodTo) url.searchParams.set("period_to", periodTo);
    return this.paginate<RateRecord>(url, false, "tariff-rates", 30 * 60 * 1000, 1500);
  }
}

export function productCodeFromTariff(tariffCode: string): string {
  const normalized = tariffCode.trim().toUpperCase();
  const match = normalized.match(/^[EG]-\dR-(.+)-[A-Z]$/);
  if (!match?.[1]) {
    throw new Error("Could not derive a product code from tariff_code; supply product_code explicitly");
  }
  return match[1];
}
