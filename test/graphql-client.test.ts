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
    expect(result).toEqual({ devices: [{ id: "device-1", name: "Meter" }] });
    expect(JSON.stringify(bodies[0])).toContain("sk_live_test_secret");
    expect(JSON.stringify(bodies[1])).not.toContain("sk_live_test_secret");
    expect(headers[0]?.has("authorization")).toBe(false);
    expect(headers[1]?.get("authorization")).toBe(`JWT ${token}`);
  });
});
