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
