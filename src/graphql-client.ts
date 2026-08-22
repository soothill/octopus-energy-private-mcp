import { createHash } from "node:crypto";
import type { FileCache } from "./cache.js";
import { OCTOPUS_GRAPHQL_URL, OCTOPUS_REST_ORIGIN, type ServerConfig } from "./config.js";
import type { RequestRateLimiter } from "./rate-limiter.js";
import type {
  CacheProvenance,
  EvChargeCostFrequency,
  EvChargeCostRecord,
  EvChargeCostsResponse,
  EvTariffPricingResponse,
  FourRateEvTariff
} from "./types.js";

interface GraphQlEnvelope<T> {
  data?: T;
  errors?: Array<{
    message?: string;
    extensions?: { errorCode?: string; code?: string; [key: string]: unknown };
  }>;
}

interface TokenMutation {
  obtainKrakenToken?: { token?: string };
}

interface EvChargeCostsQuery extends Record<string, unknown> {
  costOfCharge?: EvChargeCostRecord[] | null;
}

interface EvTariffPricingQuery extends Record<string, unknown> {
  account?: {
    electricityAgreements?: Array<{
      id?: string | number | null;
      validFrom?: string | null;
      validTo?: string | null;
      meterPoint?: { mpan?: string | null } | null;
      tariff?: ({ __typename?: string | null } & Partial<FourRateEvTariff>) | null;
    } | null> | null;
  } | null;
}

class TransientGraphQlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientGraphQlError";
  }
}

export interface GraphQlClientOptions {
  fetch?: typeof globalThis.fetch;
  url?: string;
  allowedOrigin?: string;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class OctopusGraphQlClient {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly url: URL;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private token?: string;
  private tokenExpiresAt = 0;

  constructor(
    readonly config: ServerConfig,
    readonly cache: FileCache,
    readonly limiter: RequestRateLimiter,
    options: GraphQlClientOptions = {}
  ) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.url = new URL(options.url ?? OCTOPUS_GRAPHQL_URL);
    const allowedOrigin = options.allowedOrigin ?? OCTOPUS_REST_ORIGIN;
    if (this.url.protocol !== "https:" || this.url.origin !== allowedOrigin) {
      throw new Error(`Blocked GraphQL URL; only ${allowedOrigin} is allowed`);
    }
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  private apiKey(): string {
    if (!this.config.apiKey) throw new Error("OCTOPUS_API_KEY is required for GraphQL features");
    return this.config.apiKey;
  }

  private account(override?: string): string {
    const value = override?.trim().toUpperCase() || this.config.accountNumber;
    if (!value) throw new Error("OCTOPUS_ACCOUNT_NUMBER is required for this GraphQL feature");
    if (!/^A-[A-Z0-9]+$/.test(value)) throw new Error("Account number must look like A-XXXXXXXX");
    return value;
  }

  private tokenExpiry(token: string): number {
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { exp?: number };
      if (payload.exp) return payload.exp * 1000;
    } catch {
      // Opaque or differently encoded tokens use the documented 60-minute lifetime.
    }
    return Date.now() + 55 * 60 * 1000;
  }

  private withCacheProvenance<T extends Record<string, unknown>>(
    data: T,
    cacheStatus: "disabled" | "hit" | "miss" | "stale",
    cacheAgeMs?: number
  ): T & CacheProvenance {
    return {
      ...data,
      cache_status: cacheStatus,
      stale_cache_used: cacheStatus === "stale",
      ...(cacheAgeMs === undefined ? {} : { cache_age_ms: cacheAgeMs })
    };
  }

  private async rawRequest<T>(
    query: string,
    variables: Record<string, unknown>,
    token?: string
  ): Promise<T> {
    let lastError: Error | undefined;
    let lastFailureTransient = false;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      let response: Response | undefined;
      try {
        await this.limiter.acquire();
        const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
        if (token) headers.set("Authorization", `JWT ${token}`);
        response = await this.fetchFn(this.url, {
          method: "POST",
          headers,
          redirect: "manual",
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(this.config.timeoutMs)
        });
        if (!response.ok) {
          lastError = new Error(`Octopus Energy GraphQL returned HTTP ${response.status}`);
          lastFailureTransient = response.status === 429 || response.status >= 500;
          if (!lastFailureTransient || attempt >= this.config.maxRetries) break;
        } else {
          const envelope = (await response.json()) as GraphQlEnvelope<T>;
          if (envelope.errors?.length) {
            const summaries = envelope.errors.slice(0, 5).map((error) => {
              const code = error.extensions?.errorCode ?? error.extensions?.code;
              const rawMessage = error.message ?? "Unknown GraphQL error";
              const message = this.config.apiKey ? rawMessage.replaceAll(this.config.apiKey, "[REDACTED]") : rawMessage;
              return `${code ? `[${code}] ` : ""}${message}`;
            });
            throw new Error(`Octopus Energy GraphQL error: ${summaries.join("; ")}`);
          }
          if (envelope.data === undefined) {
            throw new Error("Octopus Energy GraphQL returned no data");
          }
          return envelope.data;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Octopus Energy GraphQL request failed");
        const retryable =
          error instanceof TypeError ||
          (error instanceof DOMException && error.name === "TimeoutError") ||
          response?.status === 429 ||
          (response?.status !== undefined && response.status >= 500);
        lastFailureTransient = retryable;
        if (!retryable || attempt >= this.config.maxRetries) break;
      }
      const retryAfter = response?.headers.get("retry-after");
      const retryMs = retryAfter && Number.isFinite(Number(retryAfter))
        ? Number(retryAfter) * 1000
        : Math.min(30_000, 750 * 2 ** attempt);
      await this.sleep(Math.min(120_000, retryMs));
    }
    if (lastError && lastFailureTransient) throw new TransientGraphQlError(lastError.message);
    throw lastError ?? new Error("Octopus Energy GraphQL request failed");
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.tokenExpiresAt > Date.now() + 60_000) return this.token;
    const mutation = `
      mutation ObtainKrakenToken($input: ObtainJSONWebTokenInput!) {
        obtainKrakenToken(input: $input) { token }
      }
    `;
    const data = await this.rawRequest<TokenMutation>(mutation, { input: { APIKey: this.apiKey() } });
    const token = data.obtainKrakenToken?.token;
    if (!token) throw new Error("Octopus Energy did not return a GraphQL access token");
    this.token = token;
    this.tokenExpiresAt = this.tokenExpiry(token);
    return token;
  }

  private async query<T extends Record<string, unknown>>(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
    ttlMs: number,
    validate?: (data: T) => void
  ): Promise<T & CacheProvenance> {
    const key = `graphql:${operationName}:${createHash("sha256").update(JSON.stringify(variables)).digest("hex")}`;
    const cached = await this.cache.get<T>(key);
    if (cached) {
      validate?.(cached.value);
      return this.withCacheProvenance(cached.value, "hit", cached.ageMs);
    }
    const stale = await this.cache.get<T>(key, true);
    try {
      const data = await this.rawRequest<T>(query, variables, await this.accessToken());
      validate?.(data);
      await this.cache.set(key, "graphql", data, ttlMs);
      return this.withCacheProvenance(data, this.cache.enabled ? "miss" : "disabled");
    } catch (error) {
      if (stale && error instanceof TransientGraphQlError) {
        validate?.(stale.value);
        return this.withCacheProvenance(stale.value, "stale", stale.ageMs);
      }
      throw error;
    }
  }

  async getDevices(accountOverride?: string): Promise<unknown> {
    const query = `
      query OctopusDevices($accountNumber: String!) {
        devices(accountNumber: $accountNumber) {
          id name deviceType provider integrationDeviceId propertyId
        }
      }
    `;
    return this.query("OctopusDevices", query, { accountNumber: this.account(accountOverride) }, 60 * 60 * 1000);
  }

  async getSmartMeterDevices(accountOverride?: string): Promise<unknown> {
    const query = `
      query SmartMeterDevices($accountNumber: String!) {
        properties(accountNumber: $accountNumber, active: true) {
          id
          smartDeviceNetworks {
            id
            smartDevices {
              deviceId serialNumber manufacturer model status type paymentMode firmwareVersion
            }
          }
        }
      }
    `;
    return this.query(
      "SmartMeterDevices",
      query,
      { accountNumber: this.account(accountOverride) },
      60 * 60 * 1000
    );
  }

  async getSmartMeterTelemetry(input: {
    deviceId?: string;
    start?: string;
    end?: string;
    grouping?: "TEN_SECONDS" | "ONE_MINUTE" | "FIVE_MINUTES" | "HALF_HOURLY" | "HOURLY";
  }): Promise<unknown> {
    const deviceId = input.deviceId ?? this.config.smartMeterDeviceId;
    if (!deviceId) {
      throw new Error("A smart meter device ID is required; configure OCTOPUS_SMART_METER_DEVICE_ID or pass device_id");
    }
    const query = `
      query SmartMeterTelemetry(
        $deviceId: String!, $start: DateTime, $end: DateTime, $grouping: TelemetryGrouping
      ) {
        smartMeterTelemetry(deviceId: $deviceId, start: $start, end: $end, grouping: $grouping) {
          readAt consumption export demand consumptionDelta costDelta costDeltaWithTax
        }
      }
    `;
    return this.query("SmartMeterTelemetry", query, { ...input, deviceId }, 5 * 60 * 1000);
  }

  async getCompletedDispatches(accountOverride?: string): Promise<unknown> {
    const query = `
      query CompletedDispatches($accountNumber: String!) {
        completedDispatches(accountNumber: $accountNumber) {
          start end delta meta { source location }
        }
      }
    `;
    return this.query(
      "CompletedDispatches",
      query,
      { accountNumber: this.account(accountOverride) },
      15 * 60 * 1000
    );
  }

  async getEvChargeCosts(input: {
    accountNumber?: string;
    frequency: EvChargeCostFrequency;
    startDate: string;
    reportDate: string;
  }): Promise<EvChargeCostsResponse> {
    const assertValid: (
      data: EvChargeCostsQuery
    ) => asserts data is EvChargeCostsQuery & { costOfCharge: EvChargeCostRecord[] } = (data) => {
      if (!Array.isArray(data.costOfCharge)) {
        throw new Error("Octopus returned no EV charge cost dataset for the requested account and dates");
      }
      if (data.costOfCharge.length > this.config.maxRecordsPerCall) {
        throw new Error(
          `Octopus returned ${data.costOfCharge.length} EV charge records, exceeding OCTOPUS_MAX_RECORDS_PER_CALL=${this.config.maxRecordsPerCall}; request a shorter period or a coarser frequency`
        );
      }
    };
    const query = `
      query EvChargeCosts(
        $accountNumber: String!, $frequency: DataFrequency!, $startDate: Date, $reportDate: Date
      ) {
        costOfCharge(
          accountNumber: $accountNumber,
          frequency: $frequency,
          startDate: $startDate,
          reportDate: $reportDate
        ) {
          costOfChargeId
          isSmartCharge
          krakenflexDeviceId
          reportDate
          totalConsumption
          totalCostExclTax
          totalCostInclTax
        }
      }
    `;
    const result = await this.query<EvChargeCostsQuery>(
      "EvChargeCosts",
      query,
      {
        accountNumber: this.account(input.accountNumber),
        frequency: input.frequency,
        startDate: input.startDate,
        reportDate: input.reportDate
      },
      15 * 60 * 1000,
      assertValid
    );
    assertValid(result);
    return { ...result, costOfCharge: result.costOfCharge };
  }

  async getEvTariffPricing(accountOverride?: string): Promise<EvTariffPricingResponse> {
    const query = `
      query EvTariffPricing($accountNumber: String!) {
        account(accountNumber: $accountNumber) {
          electricityAgreements(active: true) {
            id
            validFrom
            validTo
            meterPoint { mpan }
            tariff {
              __typename
              ... on FourRateEvTariff {
                id
                tariffCode
                productCode
                displayName
                fullName
                isExport
                dayRate
                nightRate
                evDevicePeakRate
                evDeviceOffPeakRate
                standingCharge
                preVatDayRate
                preVatNightRate
                preVatEvDevicePeakRate
                preVatEvDeviceOffPeakRate
                preVatStandingCharge
              }
            }
          }
        }
      }
    `;
    const result = await this.query<EvTariffPricingQuery>(
      "EvTariffPricing",
      query,
      { accountNumber: this.account(accountOverride) },
      30 * 60 * 1000
    );
    const agreements = result.account?.electricityAgreements ?? [];
    const fourRateTariffs = agreements.flatMap((agreement) => {
      if (!agreement || agreement.tariff?.__typename !== "FourRateEvTariff") return [];
      const tariff = agreement.tariff;
      const normalizedTariff: FourRateEvTariff = {
        id: tariff.id ?? null,
        tariffCode: tariff.tariffCode ?? null,
        productCode: tariff.productCode ?? null,
        displayName: tariff.displayName ?? null,
        fullName: tariff.fullName ?? null,
        isExport: tariff.isExport ?? null,
        dayRate: tariff.dayRate ?? null,
        nightRate: tariff.nightRate ?? null,
        evDevicePeakRate: tariff.evDevicePeakRate ?? null,
        evDeviceOffPeakRate: tariff.evDeviceOffPeakRate ?? null,
        standingCharge: tariff.standingCharge ?? null,
        preVatDayRate: tariff.preVatDayRate ?? null,
        preVatNightRate: tariff.preVatNightRate ?? null,
        preVatEvDevicePeakRate: tariff.preVatEvDevicePeakRate ?? null,
        preVatEvDeviceOffPeakRate: tariff.preVatEvDeviceOffPeakRate ?? null,
        preVatStandingCharge: tariff.preVatStandingCharge ?? null
      };
      return [{
        agreementId: agreement.id === undefined || agreement.id === null ? null : String(agreement.id),
        validFrom: agreement.validFrom ?? null,
        validTo: agreement.validTo ?? null,
        meterPoint: agreement.meterPoint?.mpan ?? null,
        tariff: normalizedTariff
      }];
    });
    return {
      activeAgreementCount: agreements.filter(Boolean).length,
      fourRateTariffs,
      cache_status: result.cache_status,
      stale_cache_used: result.stale_cache_used,
      ...(result.cache_age_ms === undefined ? {} : { cache_age_ms: result.cache_age_ms })
    };
  }

  async getFlexPlannedDispatches(deviceIdOverride?: string): Promise<unknown> {
    const deviceId = deviceIdOverride ?? this.config.smartFlexDeviceId;
    if (!deviceId) {
      throw new Error("A smart-flex device ID is required; configure OCTOPUS_SMART_FLEX_DEVICE_ID or pass device_id");
    }
    const query = `
      query FlexPlannedDispatches($deviceId: String!) {
        flexPlannedDispatches(deviceId: $deviceId) { start end type energyAddedKwh }
      }
    `;
    return this.query("FlexPlannedDispatches", query, { deviceId }, 5 * 60 * 1000);
  }

  async getLoyaltyPointsBalance(accountOverride?: string): Promise<unknown> {
    const query = `
      query LoyaltyPointsBalance($input: LoyaltyPointsBalanceInput) {
        loyaltyPointsBalance(input: $input) { loyaltyPoints totalMonetaryAmount }
      }
    `;
    return this.query(
      "LoyaltyPointsBalance",
      query,
      { input: { accountNumber: this.account(accountOverride) } },
      15 * 60 * 1000
    );
  }

  async getRateLimitInfo(): Promise<unknown> {
    const query = `
      query RateLimitInfo {
        rateLimitInfo {
          pointsAllowanceRateLimit { limit remainingPoints usedPoints ttl isBlocked }
          fieldSpecificRateLimits(first: 99) {
            edges { node { field rate ttl isBlocked } }
            totalCount
          }
        }
      }
    `;
    return this.query("RateLimitInfo", query, {}, 30 * 1000);
  }
}
