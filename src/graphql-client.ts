import { createHash } from "node:crypto";
import type { FileCache } from "./cache.js";
import { OCTOPUS_GRAPHQL_URL, OCTOPUS_REST_ORIGIN, type ServerConfig } from "./config.js";
import type { RequestRateLimiter } from "./rate-limiter.js";

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

  private async rawRequest<T>(
    query: string,
    variables: Record<string, unknown>,
    token?: string
  ): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      let response: Response | undefined;
      try {
        await this.limiter.acquire();
        const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
        if (token) headers.set("Authorization", `JWT ${token}`);
        response = await this.fetchFn(this.url, {
          method: "POST",
          headers,
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(this.config.timeoutMs)
        });
        const envelope = (await response.json()) as GraphQlEnvelope<T>;
        if (!response.ok) {
          lastError = new Error(`Octopus Energy GraphQL returned HTTP ${response.status}`);
        } else if (envelope.errors?.length) {
          const summaries = envelope.errors.slice(0, 5).map((error) => {
            const code = error.extensions?.errorCode ?? error.extensions?.code;
            const rawMessage = error.message ?? "Unknown GraphQL error";
            const message = this.config.apiKey ? rawMessage.replaceAll(this.config.apiKey, "[REDACTED]") : rawMessage;
            return `${code ? `[${code}] ` : ""}${message}`;
          });
          throw new Error(`Octopus Energy GraphQL error: ${summaries.join("; ")}`);
        } else if (envelope.data === undefined) {
          throw new Error("Octopus Energy GraphQL returned no data");
        } else {
          return envelope.data;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Octopus Energy GraphQL request failed");
        const retryable =
          error instanceof TypeError ||
          (error instanceof DOMException && error.name === "TimeoutError") ||
          response?.status === 429 ||
          (response?.status !== undefined && response.status >= 500);
        if (!retryable || attempt >= this.config.maxRetries) break;
      }
      const retryAfter = response?.headers.get("retry-after");
      const retryMs = retryAfter && Number.isFinite(Number(retryAfter))
        ? Number(retryAfter) * 1000
        : Math.min(30_000, 750 * 2 ** attempt);
      await this.sleep(Math.min(120_000, retryMs));
    }
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

  private async query<T>(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
    ttlMs: number
  ): Promise<T> {
    const key = `graphql:${operationName}:${createHash("sha256").update(JSON.stringify(variables)).digest("hex")}`;
    const cached = await this.cache.get<T>(key);
    if (cached) return cached.value;
    const stale = await this.cache.get<T>(key, true);
    try {
      const data = await this.rawRequest<T>(query, variables, await this.accessToken());
      await this.cache.set(key, "graphql", data, ttlMs);
      return data;
    } catch (error) {
      if (stale) return stale.value;
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
