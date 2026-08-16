import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileCache } from "../src/cache.js";
import { OctopusRestClient } from "../src/octopus-client.js";
import { RequestRateLimiter } from "../src/rate-limiter.js";
import { testConfig } from "./helpers.js";

describe("Octopus REST client", () => {
  it("authenticates only to the allowlisted origin and discovers meters", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(new URL(input.toString()).origin).toBe("https://api.octopus.energy");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Basic ${Buffer.from("sk_live_test_secret:").toString("base64")}`
      );
      expect(init?.redirect).toBe("manual");
      return Response.json({
        number: "A-TEST1234",
        properties: [{
          id: 1,
          moved_in_at: "2025-01-01T00:00:00Z",
          moved_out_at: null,
          electricity_meter_points: [{
            mpan: "1234567890123",
            meters: [{ serial_number: "E123" }],
            agreements: [{ tariff_code: "E-1R-TEST-A", valid_from: "2025-01-01T00:00:00Z", valid_to: null }],
            is_export: false
          }],
          gas_meter_points: []
        }]
      });
    });
    const config = testConfig();
    const client = new OctopusRestClient(
      config,
      new FileCache(config.cacheDir, false),
      new RequestRateLimiter(120, 1),
      { fetch: fetchMock }
    );
    const meters = await client.discoverMeters();
    expect(meters).toMatchObject([{ fuel: "electricity", meter_point: "1234567890123", serial_number: "E123" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows bounded consumption pagination", async () => {
    let call = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      call += 1;
      const url = new URL(input.toString());
      if (url.pathname.includes("/accounts/")) {
        return Response.json({
          number: "A-TEST1234",
          properties: [{
            id: 1,
            moved_in_at: "2025-01-01T00:00:00Z",
            moved_out_at: null,
            electricity_meter_points: [{
              mpan: "123",
              meters: [{ serial_number: "SERIAL" }],
              agreements: [],
              is_export: false
            }],
            gas_meter_points: []
          }]
        });
      }
      const second = url.searchParams.get("page") === "2";
      return Response.json({
        count: 2,
        next: second ? null : "https://api.octopus.energy/v1/next/?page=2",
        previous: null,
        results: [{
          consumption: second ? 2 : 1,
          interval_start: second ? "2026-01-01T00:30:00Z" : "2026-01-01T00:00:00Z",
          interval_end: second ? "2026-01-01T01:00:00Z" : "2026-01-01T00:30:00Z"
        }]
      });
    });
    const config = testConfig({ minRequestIntervalMs: 100 });
    let now = 1000;
    const limiter = new RequestRateLimiter(120, 1, () => now, async (ms) => { now += ms; });
    const client = new OctopusRestClient(config, new FileCache(config.cacheDir, false), limiter, { fetch: fetchMock });
    const result = await client.getConsumption({
      fuel: "electricity",
      period_from: "2026-01-01T00:00:00Z",
      period_to: "2026-01-02T00:00:00Z"
    });
    expect(result.data.results.map((record) => record.consumption)).toEqual([1, 2]);
    expect(result.data.pages_fetched).toBe(2);
    expect(result.data.truncated).toBe(false);
    expect(result.data.cache_status).toBe("disabled");
    expect(result.data.stale_cache_used).toBe(false);
    expect(call).toBe(3);
  });

  it("uses the documented day and night feeds for two-register tariffs", async () => {
    const paths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      paths.push(new URL(input.toString()).pathname);
      return Response.json({ count: 0, next: null, previous: null, results: [] });
    });
    const config = testConfig();
    const client = new OctopusRestClient(
      config,
      new FileCache(config.cacheDir, false),
      new RequestRateLimiter(120, 0),
      { fetch: fetchMock }
    );
    const target = {
      fuel: "electricity" as const,
      product_code: "VAR-22-11-01",
      tariff_code: "E-2R-VAR-22-11-01-A"
    };

    await client.getTariffRates(target, "day");
    await client.getTariffRates(target, "night");

    expect(paths).toEqual([
      "/v1/products/VAR-22-11-01/electricity-tariffs/E-2R-VAR-22-11-01-A/day-unit-rates/",
      "/v1/products/VAR-22-11-01/electricity-tariffs/E-2R-VAR-22-11-01-A/night-unit-rates/"
    ]);
    await expect(client.getTariffRates(target, "unit")).rejects.toThrow("two-register tariff");
  });

  it("uses and discloses stale data only for transient failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octopus-rest-stale-"));
    try {
      const config = testConfig({ cacheDir: directory, cacheEnabled: true, maxRetries: 0 });
      const cache = new FileCache(directory, true);
      const key = "rest:GET:https://api.octopus.energy/v1/products/TEST/:";
      await cache.set(key, "products", { code: "TEST", display_name: "Cached product" }, -1);

      const transientClient = new OctopusRestClient(
        config,
        cache,
        new RequestRateLimiter(120, 0),
        { fetch: vi.fn(async () => Response.json({ detail: "temporary" }, { status: 503 })) }
      );
      const stale = await transientClient.getProduct("TEST");
      expect(stale).toMatchObject({
        code: "TEST",
        cache_status: "stale",
        stale_cache_used: true
      });
      expect(stale.cache_age_ms).toBeTypeOf("number");

      const permanentClient = new OctopusRestClient(
        config,
        cache,
        new RequestRateLimiter(120, 0),
        { fetch: vi.fn(async () => Response.json({ detail: "invalid credentials" }, { status: 401 })) }
      );
      await expect(permanentClient.getProduct("TEST")).rejects.toThrow("invalid credentials");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
