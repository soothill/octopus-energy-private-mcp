import type { ServerConfig } from "../src/config.js";

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const base: ServerConfig = {
    apiKey: "sk_live_test_secret",
    accountNumber: "A-TEST1234",
    sites: [
      {
        slug: "default",
        name: "default",
        apiKey: "sk_live_test_secret",
        accountNumber: "A-TEST1234",
        smartMeterDeviceId: "smart-meter-1",
        smartFlexDeviceId: "flex-device-1"
      }
    ],
    defaultSite: "default",
    siteId: "default",
    smartMeterDeviceId: "smart-meter-1",
    smartFlexDeviceId: "flex-device-1",
    timezone: "Europe/London",
    cacheDir: "/private/tmp/octopus-mcp-test-cache",
    cacheEnabled: false,
    historyEnabled: false,
    historyBackfillYears: 3,
    updateCheckEnabled: false,
    requestsPerMinute: 120,
    minRequestIntervalMs: 100,
    timeoutMs: 5000,
    maxRetries: 0,
    pageSize: 1500,
    maxPagesPerCall: 25,
    maxRecordsPerCall: 25_000,
    gasConsumptionUnit: "auto",
    gasM3ToKwhFactor: 11.184,
    debug: false,
    ...overrides
  };
  // Keep the default site's credentials in sync with top-level overrides so
  // tests that clear apiKey/accountNumber also clear the default site.
  if ("apiKey" in overrides || "accountNumber" in overrides) {
    base.sites = base.sites.map((site) =>
      site.slug === base.defaultSite
        ? { ...site, apiKey: base.apiKey, accountNumber: base.accountNumber }
        : site
    );
  }
  return base;
}
