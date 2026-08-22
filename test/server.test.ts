import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import type { OctopusGraphQlClient } from "../src/graphql-client.js";
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
      expect(listing.tools.length).toBeGreaterThanOrEqual(23);
      expect(listing.tools.map((tool) => tool.name)).toContain("octopus_compare_tariffs");
      expect(listing.tools.map((tool) => tool.name)).toContain("octopus_get_ev_tariff_pricing");
      expect(listing.tools.map((tool) => tool.name)).toContain("octopus_get_ev_charge_costs");
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

      const intelligentEstimate = await client.callTool({
        name: "octopus_estimate_cost",
        arguments: {
          tariff_fuel: "electricity",
          tariff_code: "E-1R-INTELLI-FIX-12M-26-08-01-A"
        }
      });
      expect(intelligentEstimate.isError).toBe(true);
      expect(intelligentEstimate.content).toMatchObject([{
        text: expect.stringContaining("octopus_get_ev_charge_costs")
      }]);

      const intelligentRates = await client.callTool({
        name: "octopus_get_tariff_rates",
        arguments: {
          fuel: "electricity",
          tariff_code: "E-1R-INTELLI-FIX-12M-26-08-01-A",
          period: "today"
        }
      });
      expect(intelligentRates.isError).toBe(true);
      expect(intelligentRates.content).toMatchObject([{
        text: expect.stringContaining("octopus_get_ev_tariff_pricing")
      }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns Octopus-priced smart and boost EV charge costs for device-aware tariffs", async () => {
    const getEvTariffPricing = vi.fn(async () => ({
      activeAgreementCount: 1,
      fourRateTariffs: [{
        agreementId: "agreement-1",
        validFrom: "2026-08-01T00:00:00+00:00",
        validTo: null,
        meterPoint: "1234567890123",
        tariff: {
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
      }],
      cache_status: "miss" as const,
      stale_cache_used: false
    }));
    const getEvChargeCosts = vi.fn(async () => ({
      costOfCharge: [
        {
          costOfChargeId: "smart-1",
          isSmartCharge: true,
          krakenflexDeviceId: "flex-1",
          reportDate: "2026-08-01",
          totalConsumption: 7.25,
          totalCostExclTax: 57.14,
          totalCostInclTax: 60
        },
        {
          costOfChargeId: "boost-1",
          isSmartCharge: false,
          krakenflexDeviceId: "flex-1",
          reportDate: "2026-08-02",
          totalConsumption: 1.25,
          totalCostExclTax: 19.05,
          totalCostInclTax: 20
        }
      ],
      cache_status: "miss" as const,
      stale_cache_used: false
    }));
    const graphql = { getEvChargeCosts, getEvTariffPricing } as unknown as OctopusGraphQlClient;
    const server = createServer(testConfig(), { graphql });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const pricing = await client.callTool({
        name: "octopus_get_ev_tariff_pricing",
        arguments: { account_number: "A-EV1234" }
      });
      expect(pricing.isError).not.toBe(true);
      expect(pricing.structuredContent).toMatchObject({
        pricing_source: "Octopus Energy account FourRateEvTariff",
        active_electricity_agreements_examined: 1,
        four_rate_ev_tariffs: [{
          tariff_code: "E-1R-INTELLI-FIX-12M-26-08-01-A",
          rates_inc_vat_pence_per_kwh: {
            home_peak: 28,
            home_off_peak: 8,
            ev_peak: 28,
            ev_off_peak: 8
          },
          standing_charge_inc_vat_pence_per_day: 45
        }]
      });
      expect(getEvTariffPricing).toHaveBeenCalledWith("A-EV1234");

      const response = await client.callTool({
        name: "octopus_get_ev_charge_costs",
        arguments: {
          account_number: "A-EV1234",
          period_from: "2026-08-01",
          period_to: "2026-08-03",
          frequency: "DAILY"
        }
      });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        octopus_date_range: { start_date: "2026-08-01", report_date: "2026-08-03" },
        pricing_source: "Octopus Energy account costOfCharge",
        pricing_model: "device_aware_ev_charging",
        summary: {
          records: 2,
          smart_charge_records: 1,
          non_smart_charge_records: 1,
          total_consumption_kwh: 8.5,
          total_cost_incl_tax_pence: 80,
          total_cost_incl_tax_gbp: 0.8
        },
        cache: { cache_status: "miss", stale_cache_used: false }
      });
      expect(getEvChargeCosts).toHaveBeenCalledWith({
        accountNumber: "A-EV1234",
        frequency: "DAILY",
        startDate: "2026-08-01",
        reportDate: "2026-08-03"
      });
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
