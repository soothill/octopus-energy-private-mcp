import type { ServerConfig } from "../src/config.js";

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    apiKey: "sk_live_test_secret",
    accountNumber: "A-TEST1234",
    smartMeterDeviceId: "smart-meter-1",
    smartFlexDeviceId: "flex-device-1",
    timezone: "Europe/London",
    cacheDir: "/private/tmp/octopus-mcp-test-cache",
    cacheEnabled: false,
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
}
