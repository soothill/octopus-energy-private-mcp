import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import type { OctopusRestClient, TariffRateKind } from "../src/octopus-client.js";
import { createServer } from "../src/server.js";
import { testConfig } from "./helpers.js";

describe("MCP server", () => {
  it("negotiates MCP, advertises its tools, and runs a local status tool", async () => {
    const server = createServer(testConfig({ apiKey: undefined, accountNumber: undefined }));
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listing = await client.listTools();
      expect(listing.tools.length).toBeGreaterThanOrEqual(21);
      expect(listing.tools.map((tool) => tool.name)).toContain("octopus_compare_tariffs");
      const response = await client.callTool({ name: "octopus_connection_status", arguments: {} });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ ready_for_account_queries: false });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns both two-register rate feeds and refuses unsafe cost replay", async () => {
    const getTariffRates = vi.fn(async (_target: unknown, kind: TariffRateKind) => ({
      count: 1,
      results: [{
        value_exc_vat: kind === "day" ? 20 : kind === "night" ? 10 : 40,
        value_inc_vat: kind === "day" ? 21 : kind === "night" ? 10.5 : 42,
        valid_from: "2026-01-01T00:00:00Z",
        valid_to: null,
        payment_method: null
      }],
      pages_fetched: 1,
      truncated: false
    }));
    const rest = { getTariffRates } as unknown as OctopusRestClient;
    const server = createServer(testConfig({ apiKey: undefined, accountNumber: undefined }), { rest });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const rates = await client.callTool({
        name: "octopus_get_tariff_rates",
        arguments: {
          fuel: "electricity",
          tariff_code: "E-2R-VAR-22-11-01-A",
          period_from: "2026-01-01",
          period_to: "2026-01-02"
        }
      });
      expect(rates.isError).not.toBe(true);
      expect(rates.structuredContent).toMatchObject({
        rate_structure: "dual_register",
        cost_replay_supported: false,
        day_unit_rates: { results: [{ value_inc_vat: 21 }] },
        night_unit_rates: { results: [{ value_inc_vat: 10.5 }] }
      });
      expect(getTariffRates.mock.calls.map((call) => call[1])).toEqual(["day", "night", "standing"]);

      const estimate = await client.callTool({
        name: "octopus_estimate_cost",
        arguments: {
          tariff_fuel: "electricity",
          tariff_code: "E-2R-VAR-22-11-01-A"
        }
      });
      expect(estimate.isError).toBe(true);
      expect(estimate.content).toMatchObject([{ text: expect.stringContaining("does not support two-register tariffs") }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses to rank export payments as import costs", async () => {
    const getTariffRates = vi.fn();
    const rest = {
      getConsumption: vi.fn(async () => ({
        meter: {
          property_id: 1,
          property_active: true,
          fuel: "electricity",
          direction: "export",
          meter_point: "123",
          serial_number: "EXPORT",
          agreements: [],
          active_tariff_code: null,
          consumption_standard: null
        },
        data: {
          count: 1,
          results: [{
            consumption: 1,
            interval_start: "2026-01-01T00:00:00Z",
            interval_end: "2026-01-01T00:30:00Z"
          }],
          pages_fetched: 1,
          truncated: false
        }
      })),
      getTariffRates
    } as unknown as OctopusRestClient;
    const server = createServer(testConfig({ apiKey: undefined, accountNumber: undefined }), { rest });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const response = await client.callTool({
        name: "octopus_estimate_cost",
        arguments: {
          fuel: "electricity",
          direction: "export",
          tariff_code: "E-1R-OUTGOING-A"
        }
      });
      expect(response.isError).toBe(true);
      expect(response.content).toMatchObject([{ text: expect.stringContaining("export readings represent tariff revenue") }]);
      expect(getTariffRates).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
