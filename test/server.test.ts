import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import type { OctopusRestClient, TariffRateKind } from "../src/octopus-client.js";
import { createServer } from "../src/server.js";
import { testConfig } from "./helpers.js";

describe("MCP server", () => {
  it("negotiates MCP, advertises its tools, and runs a local status tool", async () => {
    const server = createServer(testConfig({ apiKey: undefined, accountNumber: undefined }), {
      updateStatus: {
        status: "update_available",
        current_version: "0.2.0",
        latest_version: "0.3.0",
        checked_at: "2026-08-21T00:00:00.000Z",
        message: "A newer Octopus Energy Private MCP version is available: 0.3.0 (installed: 0.2.0).",
        instructions: {
          git: "Git install: run `git pull --ff-only`, `npm ci`, and `npm run build`, then restart.",
          zip: "ZIP install: keep `.env`, download the latest ZIP, rebuild, update the MCP path, then restart.",
          full_guide: "https://github.com/soothill/octopus-energy-private-mcp/blob/main/docs/INSTALLATION.md#updating-later"
        }
      }
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect(client.getInstructions()).toContain("Tell the user about this update");
      expect(client.getInstructions()).toContain("0.3.0 (installed: 0.2.0)");
      const listing = await client.listTools();
      expect(listing.tools.length).toBeGreaterThanOrEqual(21);
      expect(listing.tools.map((tool) => tool.name)).toContain("octopus_compare_tariffs");
      const response = await client.callTool({ name: "octopus_connection_status", arguments: {} });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        ready_for_account_queries: false,
        update: {
          status: "update_available",
          current_version: "0.2.0",
          latest_version: "0.3.0"
        }
      });
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
