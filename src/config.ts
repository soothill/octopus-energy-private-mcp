import { homedir } from "node:os";
import { join } from "node:path";
import type { GasConsumptionUnit } from "./types.js";

export const OCTOPUS_REST_ORIGIN = "https://api.octopus.energy";
export const OCTOPUS_REST_BASE_URL = `${OCTOPUS_REST_ORIGIN}/v1/`;
export const OCTOPUS_GRAPHQL_URL = `${OCTOPUS_REST_ORIGIN}/v1/graphql/`;

export interface ServerConfig {
  apiKey: string | undefined;
  accountNumber: string | undefined;
  smartMeterDeviceId: string | undefined;
  smartFlexDeviceId: string | undefined;
  timezone: string;
  cacheDir: string;
  cacheEnabled: boolean;
  updateCheckEnabled: boolean;
  requestsPerMinute: number;
  minRequestIntervalMs: number;
  timeoutMs: number;
  maxRetries: number;
  pageSize: number;
  maxPagesPerCall: number;
  maxRecordsPerCall: number;
  gasConsumptionUnit: GasConsumptionUnit;
  gasM3ToKwhFactor: number;
  debug: boolean;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return parsed;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = optionalEnv(name)?.toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function validateAccountNumber(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.toUpperCase();
  if (!/^A-[A-Z0-9]+$/.test(normalized)) {
    throw new Error("OCTOPUS_ACCOUNT_NUMBER must look like A-XXXXXXXX");
  }
  return normalized;
}

function gasUnitEnv(): GasConsumptionUnit {
  const value = optionalEnv("OCTOPUS_GAS_CONSUMPTION_UNIT")?.toLowerCase() ?? "auto";
  if (value === "auto" || value === "kwh" || value === "m3") return value;
  throw new Error("OCTOPUS_GAS_CONSUMPTION_UNIT must be auto, kwh, or m3");
}

export function loadConfig(): ServerConfig {
  return {
    apiKey: optionalEnv("OCTOPUS_API_KEY"),
    accountNumber: validateAccountNumber(optionalEnv("OCTOPUS_ACCOUNT_NUMBER")),
    smartMeterDeviceId: optionalEnv("OCTOPUS_SMART_METER_DEVICE_ID"),
    smartFlexDeviceId: optionalEnv("OCTOPUS_SMART_FLEX_DEVICE_ID"),
    timezone: optionalEnv("OCTOPUS_TIMEZONE") ?? "Europe/London",
    cacheDir:
      optionalEnv("OCTOPUS_CACHE_DIR") ?? join(homedir(), ".cache", "octopus-energy-mcp"),
    cacheEnabled: booleanEnv("OCTOPUS_CACHE_ENABLED", true),
    updateCheckEnabled: booleanEnv("OCTOPUS_UPDATE_CHECK_ENABLED", true),
    requestsPerMinute: integerEnv("OCTOPUS_REQUESTS_PER_MINUTE", 30, 1, 120),
    minRequestIntervalMs: integerEnv("OCTOPUS_MIN_REQUEST_INTERVAL_MS", 1000, 100, 60_000),
    timeoutMs: integerEnv("OCTOPUS_REQUEST_TIMEOUT_MS", 20_000, 1000, 120_000),
    maxRetries: integerEnv("OCTOPUS_MAX_RETRIES", 3, 0, 8),
    pageSize: integerEnv("OCTOPUS_PAGE_SIZE", 1500, 1, 25_000),
    maxPagesPerCall: integerEnv("OCTOPUS_MAX_PAGES_PER_CALL", 25, 1, 100),
    maxRecordsPerCall: integerEnv("OCTOPUS_MAX_RECORDS_PER_CALL", 25_000, 100, 250_000),
    gasConsumptionUnit: gasUnitEnv(),
    gasM3ToKwhFactor: numberEnv("OCTOPUS_GAS_M3_TO_KWH_FACTOR", 11.184, 8, 14),
    debug: booleanEnv("OCTOPUS_DEBUG", false)
  };
}

export function publicConfig(config: ServerConfig): Record<string, unknown> {
  return {
    account_configured: Boolean(config.accountNumber),
    api_key_configured: Boolean(config.apiKey),
    smart_meter_device_configured: Boolean(config.smartMeterDeviceId),
    smart_flex_device_configured: Boolean(config.smartFlexDeviceId),
    timezone: config.timezone,
    cache_enabled: config.cacheEnabled,
    cache_directory: config.cacheDir,
    update_check_enabled: config.updateCheckEnabled,
    requests_per_minute: config.requestsPerMinute,
    minimum_request_interval_ms: config.minRequestIntervalMs,
    request_timeout_ms: config.timeoutMs,
    maximum_retries: config.maxRetries,
    page_size: config.pageSize,
    maximum_pages_per_tool_call: config.maxPagesPerCall,
    maximum_records_per_tool_call: config.maxRecordsPerCall,
    gas_consumption_unit: config.gasConsumptionUnit,
    gas_m3_to_kwh_factor: config.gasM3ToKwhFactor,
    allowed_outbound_hosts: [
      "api.octopus.energy",
      ...(config.updateCheckEnabled ? ["api.github.com"] : [])
    ]
  };
}
