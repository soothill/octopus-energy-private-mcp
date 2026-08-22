import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileCache } from "../src/cache.js";
import { OctopusGraphQlClient } from "../src/graphql-client.js";
import { RequestRateLimiter } from "../src/rate-limiter.js";
import { testConfig } from "./helpers.js";

describe("Octopus GraphQL client", () => {
  it("exchanges the API key for an in-memory token and runs only a named operation", async () => {
    const jwtPayload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    const token = `header.${jwtPayload}.signature`;
    const bodies: Array<Record<string, unknown>> = [];
    const headers: Headers[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(input.toString()).toBe("https://api.octopus.energy/v1/graphql/");
      expect(init?.redirect).toBe("manual");
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      headers.push(new Headers(init?.headers));
      if (bodies.length === 1) return Response.json({ data: { obtainKrakenToken: { token } } });
      return Response.json({ data: { devices: [{ id: "device-1", name: "Meter" }] } });
    });
    const config = testConfig();
    const client = new OctopusGraphQlClient(
      config,
      new FileCache(config.cacheDir, false),
      new RequestRateLimiter(120, 1),
      { fetch: fetchMock }
    );
    const result = await client.getDevices();
    expect(result).toMatchObject({
      devices: [{ id: "device-1", name: "Meter" }],
      cache_status: "disabled",
      stale_cache_used: false
    });
    expect(JSON.stringify(bodies[0])).toContain("sk_live_test_secret");
    expect(JSON.stringify(bodies[1])).not.toContain("sk_live_test_secret");
    expect(headers[0]?.has("authorization")).toBe(false);
    expect(headers[1]?.get("authorization")).toBe(`JWT ${token}`);
  });

  it("requests Octopus-priced EV charge costs with account and date boundaries", async () => {
    const bodies: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      calls += 1;
      bodies.push(JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> });
      if (calls === 1) return Response.json({ data: { obtainKrakenToken: { token: "opaque-token" } } });
      return Response.json({
        data: {
          costOfCharge: [{
            costOfChargeId: "charge-1",
            isSmartCharge: true,
            krakenflexDeviceId: "flex-1",
            reportDate: "2026-08-01",
            totalConsumption: 7.25,
            totalCostExclTax: 57.14,
            totalCostInclTax: 60
          }]
        }
      });
    });
    const config = testConfig();
    const client = new OctopusGraphQlClient(
      config,
      new FileCache(config.cacheDir, false),
      new RequestRateLimiter(120, 1),
      { fetch: fetchMock }
    );

    await expect(client.getEvChargeCosts({
      accountNumber: "a-ev1234",
      frequency: "DAILY",
      startDate: "2026-08-01",
      reportDate: "2026-08-03"
    })).resolves.toMatchObject({
      costOfCharge: [{
        costOfChargeId: "charge-1",
        isSmartCharge: true,
        totalConsumption: 7.25,
        totalCostInclTax: 60
      }],
      cache_status: "disabled",
      stale_cache_used: false
    });
    expect(bodies[1]?.query).toContain("query EvChargeCosts");
    expect(bodies[1]?.query).toContain("totalCostInclTax");
    expect(bodies[1]?.variables).toEqual({
      accountNumber: "A-EV1234",
      frequency: "DAILY",
      startDate: "2026-08-01",
      reportDate: "2026-08-03"
    });
  });

  it("returns active four-rate EV tariff prices with separate home and device rates", async () => {
    const bodies: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      calls += 1;
      bodies.push(JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> });
      if (calls === 1) return Response.json({ data: { obtainKrakenToken: { token: "opaque-token" } } });
      return Response.json({
        data: {
          account: {
            electricityAgreements: [
              {
                id: 123,
                validFrom: "2026-08-01T00:00:00+00:00",
                validTo: null,
                meterPoint: { mpan: "1234567890123" },
                tariff: {
                  __typename: "FourRateEvTariff",
                  id: "tariff-1",
                  tariffCode: "E-1R-INTELLI-FIX-12M-26-08-01-A",
                  productCode: "INTELLI-FIX-12M-26-08-01",
                  displayName: "Intelligent Octopus Go",
                  fullName: "Intelligent Octopus Go August 2026",
                  isExport: false,
                  dayRate: 28,
                  nightRate: 8,
                  evDevicePeakRate: 28,
                  evDeviceOffPeakRate: 8,
                  standingCharge: 45,
                  preVatDayRate: 26.6667,
                  preVatNightRate: 7.619,
                  preVatEvDevicePeakRate: 26.6667,
                  preVatEvDeviceOffPeakRate: 7.619,
                  preVatStandingCharge: 42.8571
                }
              },
              { id: 456, tariff: { __typename: "StandardTariff" } }
            ]
          }
        }
      });
    });
    const config = testConfig();
    const client = new OctopusGraphQlClient(
      config,
      new FileCache(config.cacheDir, false),
      new RequestRateLimiter(120, 1),
      { fetch: fetchMock }
    );

    await expect(client.getEvTariffPricing("a-ev1234")).resolves.toMatchObject({
      activeAgreementCount: 2,
      fourRateTariffs: [{
        agreementId: "123",
        meterPoint: "1234567890123",
        tariff: {
          tariffCode: "E-1R-INTELLI-FIX-12M-26-08-01-A",
          dayRate: 28,
          nightRate: 8,
          evDevicePeakRate: 28,
          evDeviceOffPeakRate: 8
        }
      }],
      cache_status: "disabled",
      stale_cache_used: false
    });
    expect(bodies[1]?.query).toContain("query EvTariffPricing");
    expect(bodies[1]?.query).toContain("... on FourRateEvTariff");
    expect(bodies[1]?.variables).toEqual({ accountNumber: "A-EV1234" });
  });

  it("uses and discloses stale query data only for transient failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octopus-graphql-stale-"));
    try {
      const config = testConfig({ cacheDir: directory, cacheEnabled: true, maxRetries: 0 });
      const cache = new FileCache(directory, true);
      const variables = { accountNumber: "A-TEST1234" };
      const key = `graphql:OctopusDevices:${createHash("sha256").update(JSON.stringify(variables)).digest("hex")}`;
      await cache.set(key, "graphql", { devices: [{ id: "cached-device" }] }, -1);
      const tokenResponse = { data: { obtainKrakenToken: { token: "opaque-token" } } };
      let transientCalls = 0;
      const transientClient = new OctopusGraphQlClient(
        config,
        cache,
        new RequestRateLimiter(120, 0),
        {
          fetch: vi.fn(async () => {
            transientCalls += 1;
            return transientCalls === 1
              ? Response.json(tokenResponse)
              : Response.json({}, { status: 503 });
          })
        }
      );
      const stale = await transientClient.getDevices() as Record<string, unknown>;
      expect(stale).toMatchObject({
        devices: [{ id: "cached-device" }],
        cache_status: "stale",
        stale_cache_used: true
      });
      expect(stale.cache_age_ms).toBeTypeOf("number");

      let permanentCalls = 0;
      const permanentClient = new OctopusGraphQlClient(
        config,
        cache,
        new RequestRateLimiter(120, 0),
        {
          fetch: vi.fn(async () => {
            permanentCalls += 1;
            return permanentCalls === 1
              ? Response.json(tokenResponse)
              : Response.json({ errors: [{ message: "Unauthorized", extensions: { errorCode: "KT-CT-1111" } }] });
          })
        }
      );
      await expect(permanentClient.getDevices()).rejects.toThrow("Unauthorized");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
