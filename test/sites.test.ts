import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, loadSites, siteSlug } from "../src/config.js";
import { SiteRegistry } from "../src/sites.js";
import { createServer } from "../src/server.js";
import { testConfig } from "./helpers.js";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OCTOPUS_")) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("site configuration", () => {
  it("falls back to a single default site from the legacy variables", () => {
    process.env.OCTOPUS_API_KEY = "sk_live_legacy";
    process.env.OCTOPUS_ACCOUNT_NUMBER = "A-LEGACY01";
    const { sites, defaultSite } = loadSites();
    expect(defaultSite).toBe("default");
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ slug: "default", apiKey: "sk_live_legacy", accountNumber: "A-LEGACY01" });
  });

  it("parses named sites with their own keys and honours the default", () => {
    process.env.OCTOPUS_SITES = "York,Newport Pagnell";
    process.env.OCTOPUS_SITE_YORK_NAME = "York";
    process.env.OCTOPUS_SITE_YORK_API_KEY = "sk_live_york";
    process.env.OCTOPUS_SITE_YORK_ACCOUNT_NUMBER = "A-YORK0001";
    process.env.OCTOPUS_SITE_NEWPORT_PAGNELL_NAME = "Newport Pagnell";
    process.env.OCTOPUS_SITE_NEWPORT_PAGNELL_API_KEY = "sk_live_newport";
    process.env.OCTOPUS_SITE_NEWPORT_PAGNELL_ACCOUNT_NUMBER = "A-NEWPORT1";
    process.env.OCTOPUS_DEFAULT_SITE = "newport-pagnell";
    const config = loadConfig();
    expect(config.sites.map((site) => site.slug)).toEqual(["york", "newport-pagnell"]);
    expect(config.defaultSite).toBe("newport-pagnell");
    expect(config.apiKey).toBe("sk_live_newport");
    expect(config.accountNumber).toBe("A-NEWPORT1");
    const york = config.sites.find((site) => site.slug === "york");
    expect(york).toMatchObject({ name: "York", apiKey: "sk_live_york", accountNumber: "A-YORK0001" });
  });

  it("rejects unknown defaults and duplicate sites", () => {
    process.env.OCTOPUS_SITES = "york,york";
    expect(() => loadSites()).toThrow(/duplicate/i);
    process.env.OCTOPUS_SITES = "york";
    process.env.OCTOPUS_DEFAULT_SITE = "leeds";
    expect(() => loadSites()).toThrow(/not listed/i);
  });

  it("normalises friendly names into slugs", () => {
    expect(siteSlug("Newport Pagnell")).toBe("newport-pagnell");
    expect(siteSlug("  York  ")).toBe("york");
  });
});

describe("site registry", () => {
  it("resolves sites by slug or friendly name and rejects unknown ones", () => {
    const config = testConfig({
      sites: [
        { slug: "york", name: "York", apiKey: "k1", accountNumber: "A-YORK0001", smartMeterDeviceId: undefined, smartFlexDeviceId: undefined },
        { slug: "newport-pagnell", name: "Newport Pagnell", apiKey: "k2", accountNumber: "A-NEWPORT1", smartMeterDeviceId: undefined, smartFlexDeviceId: undefined }
      ],
      defaultSite: "york"
    });
    const registry = new SiteRegistry(config);
    expect(registry.find("york").name).toBe("York");
    expect(registry.find("Newport Pagnell").slug).toBe("newport-pagnell");
    expect(registry.find()?.slug).toBe("york");
    expect(() => registry.find("leeds")).toThrow(/Unknown site "leeds"/);
    expect(registry.resolve("york").config.apiKey).toBe("k1");
    expect(registry.resolve("newport-pagnell").config.accountNumber).toBe("A-NEWPORT1");
    expect(registry.resolve("york")).toBe(registry.resolve("york"));
  });
});

describe("multi-site MCP tools", () => {
  it("routes account tools to the selected site's credentials", async () => {
    const getAccountYork = vi.fn(async () => ({ number: "A-YORK0001", properties: [] }));
    const getAccountNewport = vi.fn(async () => ({ number: "A-NEWPORT1", properties: [] }));
    const config = testConfig({
      apiKey: "sk_live_york",
      accountNumber: "A-YORK0001",
      sites: [
        { slug: "york", name: "York", apiKey: "sk_live_york", accountNumber: "A-YORK0001", smartMeterDeviceId: undefined, smartFlexDeviceId: undefined },
        { slug: "newport-pagnell", name: "Newport Pagnell", apiKey: "sk_live_newport", accountNumber: "A-NEWPORT1", smartMeterDeviceId: undefined, smartFlexDeviceId: undefined }
      ],
      defaultSite: "york"
    });
    const registry = new SiteRegistry(config);
    registry.resolve("york").rest.getAccount = getAccountYork as never;
    registry.resolve("newport-pagnell").rest.getAccount = getAccountNewport as never;
    const server = createServer(config, { sites: registry });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const sites = await client.callTool({ name: "octopus_list_sites", arguments: {} });
      expect(sites.structuredContent).toMatchObject({
        default_site: "york",
        sites: [
          { name: "York", slug: "york", is_default: true },
          { name: "Newport Pagnell", slug: "newport-pagnell", is_default: false }
        ]
      });

      const defaulted = await client.callTool({ name: "octopus_get_account", arguments: {} });
      expect(defaulted.isError).not.toBe(true);
      const york = await client.callTool({ name: "octopus_get_account", arguments: { site: "York" } });
      expect(york.isError).not.toBe(true);
      const newport = await client.callTool({
        name: "octopus_get_account",
        arguments: { site: "newport-pagnell" }
      });
      expect(newport.isError).not.toBe(true);
      expect(newport.structuredContent).toMatchObject({ number: "A-NEWPORT1" });
      expect(getAccountNewport).toHaveBeenCalled();

      const unknown = await client.callTool({ name: "octopus_get_account", arguments: { site: "leeds" } });
      expect(unknown.isError).toBe(true);
      expect(unknown.content).toMatchObject([{ text: expect.stringContaining("Unknown site") }]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
