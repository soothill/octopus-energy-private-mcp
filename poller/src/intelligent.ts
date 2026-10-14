import type { SiteConfig } from "./config.js";

const KRAKEN_ORIGIN = "https://api.oegb-kraken.energy";
const KRAKEN_GRAPHQL_URL = `${KRAKEN_ORIGIN}/v1/graphql/`;

export interface IntelligentDevice {
  id: string;
  deviceType: string;
  provider: string;
  status: { current: string | null } | null;
}

export interface PlannedDispatch {
  start: string;
  end: string;
  type: string;
  energyAddedKwh: string | null;
}

export interface CompletedDispatch {
  start: string;
  end: string;
  delta: string | null;
  meta: { source: string | null; location: string | null } | null;
}

function decodeJwtExpiryMs(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Malformed Kraken GraphQL token");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
  if (!claims.exp) throw new Error("Kraken GraphQL token has no expiry claim");
  return claims.exp * 1000;
}

/**
 * Client for the Octopus Intelligent (SmartFlex) GraphQL API.
 * The personal API key is exchanged for a short-lived JWT via `obtainKrakenToken`;
 * dispatch windows (planned/completed) are then queried with that JWT.
 */
export class IntelligentGraphqlClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private lastRequestAt = 0;

  constructor(
    private readonly site: SiteConfig,
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async post(query: string, token: string | null): Promise<Record<string, any>> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      const wait = this.lastRequestAt + this.options.minRequestIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();
      try {
        const response = await this.fetchFn(KRAKEN_GRAPHQL_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: token } : {})
          },
          body: JSON.stringify({ query }),
          signal: AbortSignal.timeout(this.options.timeoutMs)
        });
        if (!response.ok) {
          throw new Error(`Kraken GraphQL HTTP ${response.status}`);
        }
        const body = (await response.json()) as { data?: Record<string, any>; errors?: Array<{ message: string }> };
        if (body.errors?.length) {
          throw new Error(`Kraken GraphQL: ${body.errors.map((error) => error.message).join("; ")}`);
        }
        return body.data ?? {};
      } catch (error) {
        lastError = error;
        if (attempt < this.options.maxRetries) await this.sleep(750 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Kraken GraphQL request failed");
  }

  private async ensureToken(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return;
    const data = await this.post(
      `mutation { obtainKrakenToken(input: { APIKey: "${this.site.apiKey}" }) { token } }`,
      null
    );
    const token: unknown = data?.obtainKrakenToken?.token;
    if (typeof token !== "string" || !token) {
      throw new Error("Failed to obtain Kraken GraphQL token for site " + this.site.name);
    }
    this.token = token;
    this.tokenExpiresAt = decodeJwtExpiryMs(token);
  }

  private async graphql(query: string): Promise<Record<string, any>> {
    await this.ensureToken();
    return this.post(query, this.token);
  }

  /** SmartFlex devices on the account (electricity meter, EVs, charge points, batteries). */
  async listDevices(): Promise<IntelligentDevice[]> {
    const data = await this.graphql(
      `query { devices(accountNumber: "${this.site.accountNumber}") { id deviceType provider status { current } } }`
    );
    return (data.devices ?? []) as IntelligentDevice[];
  }

  /** Planned dispatches for one device, ~24h ahead. */
  async plannedDispatches(deviceId: string): Promise<PlannedDispatch[]> {
    const data = await this.graphql(
      `query { flexPlannedDispatches(deviceId: "${deviceId}") { start end type energyAddedKwh } }`
    );
    return (data.flexPlannedDispatches ?? []) as PlannedDispatch[];
  }

  /** Completed dispatches for the account, ~12h behind. */
  async completedDispatches(): Promise<CompletedDispatch[]> {
    const data = await this.graphql(
      `query { completedDispatches(accountNumber: "${this.site.accountNumber}") { start end delta meta { source location } } }`
    );
    return (data.completedDispatches ?? []) as CompletedDispatch[];
  }
}
